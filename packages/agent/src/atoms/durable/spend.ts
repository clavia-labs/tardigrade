import { atom, durableAtom, ObservedCoreEvent, type RecordMetadata } from "@clavia/tardigrade-core"
import { Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { Event } from "../../contracts/events"

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const ToolSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, count: Count }))
const TokenSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, input: Count, output: Count }))
const UsdSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }))
const TimeSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, ms: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }))
const Calls = Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String }))
export const SpendState = Schema.Struct({
  toolSpend: ToolSpend, tokenSpend: TokenSpend, usdSpend: UsdSpend, timeSpend: TimeSpend, timers: Schema.Array(Schema.Struct({ turnId: Schema.String, index: Count, startedAt: Schema.NullOr(Count) })),
  turns: Schema.Array(Schema.String), models: Calls, tools: Calls,
})
const SpendEvent = Schema.Union([Event, ObservedCoreEvent])

const Spend = Schema.Struct({ turnId: Schema.String, count: Count, input: Count, output: Count, usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), ms: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), startedAt: Schema.NullOr(Count) })
export const SpendCollections = Schema.Struct({ totals: Schema.Record(Schema.String, Spend), pending: Schema.Array(Schema.String), models: Schema.Record(Schema.String, Schema.String), tools: Schema.Record(Schema.String, Schema.String) })
// reduceSpend updates ordered turn totals and pending call attribution (platform/test/properties/actors.ts).
function reduceSpend(state: typeof SpendState.Type, event: typeof SpendEvent.Type, metadata: RecordMetadata): typeof SpendState.Type {
  if (metadata.recordedAt !== undefined) {
    let updated: Array<typeof TimeSpend.Type[number]> | undefined
    for (const timer of state.timers) {
      if (timer.startedAt === null) continue
      const turn = state.timeSpend[timer.index]!
      const ms = Math.max(0, metadata.recordedAt - timer.startedAt)
      if (turn.ms === ms) continue
      updated ??= state.timeSpend.slice()
      updated[timer.index] = { ...turn, ms }
    }
    if (updated) state = { ...state, timeSpend: updated }
  }
  if (event.type === "TurnRequested") {
    if (state.toolSpend.some(turn => turn.turnId === event.turnId)) return state
    const turnId = event.turnId
    return {
      ...state, turns: [...state.turns, turnId],
      timers: [...state.timers, { turnId, index: state.timeSpend.length, startedAt: metadata.recordedAt ?? null }],
      timeSpend: [...state.timeSpend, { turnId, ms: metadata.recordedAt === undefined ? null : 0 }],
      toolSpend: [...state.toolSpend, { turnId, count: 0 }],
      tokenSpend: [...state.tokenSpend, { turnId, input: 0, output: 0 }],
      usdSpend: [...state.usdSpend, { turnId, usd: 0 }],
    }
  }
  if (event.type === "ModelCalled") {
    const turnId = event.purpose === "inference" ? event.turnId : state.turns[0]
    if (turnId === undefined || state.models.some(call => call.callId === event.callId)) return state
    return { ...state, models: [...state.models, { callId: event.callId, turnId }] }
  }
  if (event.type === "ModelReturned") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    const usage = event.usage
    return {
      ...state, models: state.models.filter(value => value !== call),
      tools: event.purpose === "inference" ? [...state.tools, ...event.toolCalls.map(tool => ({ callId: tool.callId, turnId: call.turnId }))] : state.tools,
      tokenSpend: usage ? state.tokenSpend.map(turn => turn.turnId === call.turnId
        ? { ...turn, input: turn.input + (usage.input ?? 0), output: turn.output + (usage.output ?? 0) } : turn) : state.tokenSpend,
      usdSpend: state.usdSpend.map(turn => turn.turnId === call.turnId
        ? { ...turn, usd: turn.usd === null || usage?.usd == null ? null : turn.usd + usage.usd } : turn),
    }
  }
  if (event.type === "ToolCalled" || event.type === "ToolReturned") {
    const call = state.tools.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      ...state, tools: state.tools.filter(value => value !== call),
      toolSpend: event.type === "ToolCalled" && event.counted
        ? state.toolSpend.map(turn => turn.turnId === call.turnId ? { ...turn, count: turn.count + 1 } : turn) : state.toolSpend,
    }
  }
  if (event.type === "CompactionFailed" || event.type === "ModelFailed") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      ...state, models: state.models.filter(value => value !== call),
      usdSpend: state.usdSpend.map(turn => turn.turnId === call.turnId ? { ...turn, usd: null } : turn),
    }
  }
  if (event.type !== "TurnSettled") return state
  const timer = state.timers.find(timer => timer.turnId === event.turnId)
  if (timer && (metadata.recordedAt === undefined || timer.startedAt === null) && state.timeSpend[timer.index]!.ms !== null) {
    const timeSpend = state.timeSpend.slice()
    timeSpend[timer.index] = { turnId: event.turnId, ms: null }
    state = { ...state, timeSpend }
  }
  return {
    ...state, turns: state.turns.filter(turnId => turnId !== event.turnId),
    timers: state.timers.filter(timer => timer.turnId !== event.turnId),
    models: state.models.filter(call => call.turnId !== event.turnId),
    tools: state.tools.filter(call => call.turnId !== event.turnId),
    usdSpend: state.models.some(call => call.turnId === event.turnId)
      ? state.usdSpend.map(turn => turn.turnId === event.turnId ? { ...turn, usd: null } : turn) : state.usdSpend,
  }
}

export const spendRecords = durableAtom({
  name: "agent.spend", input: SpendEvent, schema: SpendState,
  initial: { toolSpend: [], tokenSpend: [], usdSpend: [], timeSpend: [], timers: [], turns: [], models: [], tools: [] },
  migrate: stored => {
    if (Schema.is(SpendState)(stored)) return stored
    const state = Schema.decodeUnknownSync(SpendCollections)(stored), totals = Object.values(state.totals)
    return {
      toolSpend: totals.map(({ turnId, count }) => ({ turnId, count })), tokenSpend: totals.map(({ turnId, input, output }) => ({ turnId, input, output })),
      usdSpend: totals.map(({ turnId, usd }) => ({ turnId, usd })), timeSpend: totals.map(({ turnId, ms }) => ({ turnId, ms })), turns: state.pending,
      timers: state.pending.map(turnId => ({ turnId, index: totals.findIndex(turn => turn.turnId === turnId), startedAt: state.totals[JSON.stringify(turnId)]!.startedAt })),
      models: Object.entries(state.models).map(([callId, turnId]) => ({ callId, turnId })), tools: Object.entries(state.tools).map(([callId, turnId]) => ({ callId, turnId })),
    }
  },
  reduce: reduceSpend,
})

export const spendState = atom(get => get(spendRecords))

// toolSpend records budget-counted tool calls per turn, including execution failures.
export const toolSpend = atom(get => get(spendState).toolSpend)
// tokenSpend sums recorded provider input and output tokens per turn, including compaction.
export const tokenSpend = atom(get => get(spendState).tokenSpend)
// usdSpend sums reported provider costs per turn; a missing cost makes that turn's total unknown.
export const usdSpend = atom(get => get(spendState).usdSpend)
// timeSpend records wall milliseconds from turn request to turn settlement at journal boundaries, including queueing and downtime; missing timestamps produce unknown totals.
export const timeSpend = NativeAtom.readable(get => {
  const next = get(spendState).timeSpend, previous = Option.getOrUndefined(get.self<typeof next>())
  return next.map((value, index) => { const before = previous?.[index]; return before?.turnId === value.turnId && before.ms === value.ms ? before : value })
}).pipe(NativeAtom.keepAlive)
