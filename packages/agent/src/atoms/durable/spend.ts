import { atom, durableAtom, ObservedCoreEvent, type Editor, type RecordMetadata } from "@clavia/tardigrade-core"
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
function editSpend(state: Editor<typeof SpendState.Type>, event: typeof SpendEvent.Type, metadata: RecordMetadata) {
  const findTotal = (turnId: string) => {
    for (let index = state.length(["timeSpend"]) - 1; index >= 0; index--) if (state.read(["timeSpend", index, "turnId"]) === turnId) return index
    return -1
  }
  const timers = state.read(["timers"])
  if (metadata.recordedAt !== undefined) for (const timer of timers) {
    if (timer.startedAt === null) continue
    const ms = Math.max(0, metadata.recordedAt - timer.startedAt)
    if (state.read(["timeSpend", timer.index, "ms"]) !== ms) state.set(["timeSpend", timer.index, "ms"], ms)
  }
  if (event.type === "TurnRequested") {
    if (findTotal(event.turnId) >= 0) return
    const turnId = event.turnId
    state.append(["turns"], [turnId])
    state.append(["timers"], [{ turnId, index: state.length(["timeSpend"]), startedAt: metadata.recordedAt ?? null }])
    state.append(["timeSpend"], [{ turnId, ms: metadata.recordedAt === undefined ? null : 0 }])
    state.append(["toolSpend"], [{ turnId, count: 0 }])
    state.append(["tokenSpend"], [{ turnId, input: 0, output: 0 }])
    state.append(["usdSpend"], [{ turnId, usd: 0 }])
    return
  }
  const models = state.read(["models"])
  if (event.type === "ModelCalled") {
    const turnId = event.purpose === "inference" ? event.turnId : state.read(["turns"])[0]
    if (turnId !== undefined && !models.some(call => call.callId === event.callId)) state.append(["models"], [{ callId: event.callId, turnId }])
    return
  }
  if (event.type === "ModelReturned" || event.type === "CompactionFailed" || event.type === "ModelFailed") {
    const call = models.find(call => call.callId === event.callId)
    if (!call) return
    state.set(["models"], models.filter(value => value !== call))
    const index = findTotal(call.turnId)
    if (event.type !== "ModelReturned") {
      if (index >= 0) state.set(["usdSpend", index, "usd"], null)
      return
    }
    if (event.purpose === "inference") state.append(["tools"], event.toolCalls.map(tool => ({ callId: tool.callId, turnId: call.turnId })))
    if (index < 0) return
    const usage = event.usage
    if (usage) {
      const turn = state.read(["tokenSpend", index])
      state.set(["tokenSpend", index, "input"], turn.input + (usage.input ?? 0))
      state.set(["tokenSpend", index, "output"], turn.output + (usage.output ?? 0))
    }
    const usd = state.read(["usdSpend", index, "usd"])
    state.set(["usdSpend", index, "usd"], usd === null || usage?.usd == null ? null : usd + usage.usd)
    return
  }
  if (event.type === "ToolCalled" || event.type === "ToolReturned") {
    const tools = state.read(["tools"]), call = tools.find(call => call.callId === event.callId)
    if (!call) return
    state.set(["tools"], tools.filter(value => value !== call))
    const index = findTotal(call.turnId)
    if (event.type === "ToolCalled" && event.counted && index >= 0) state.set(["toolSpend", index, "count"], state.read(["toolSpend", index, "count"]) + 1)
    return
  }
  if (event.type !== "TurnSettled") return
  const timer = timers.find(timer => timer.turnId === event.turnId)
  if (timer && (metadata.recordedAt === undefined || timer.startedAt === null) && state.read(["timeSpend", timer.index, "ms"]) !== null) state.set(["timeSpend", timer.index, "ms"], null)
  state.set(["turns"], state.read(["turns"]).filter(turnId => turnId !== event.turnId))
  state.set(["timers"], timers.filter(timer => timer.turnId !== event.turnId))
  state.set(["models"], models.filter(call => call.turnId !== event.turnId))
  state.set(["tools"], state.read(["tools"]).filter(call => call.turnId !== event.turnId))
  if (models.some(call => call.turnId === event.turnId)) {
    const index = findTotal(event.turnId)
    if (index >= 0) state.set(["usdSpend", index, "usd"], null)
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
  edit: editSpend,
})

export const spendState = atom(get => get(spendRecords).read([]))

// toolSpend records budget-counted tool calls per turn, including execution failures.
export const toolSpend = atom(get => get(spendRecords).read(["toolSpend"]))
// tokenSpend sums recorded provider input and output tokens per turn, including compaction.
export const tokenSpend = atom(get => get(spendRecords).read(["tokenSpend"]))
// usdSpend sums reported provider costs per turn; a missing cost makes that turn's total unknown.
export const usdSpend = atom(get => get(spendRecords).read(["usdSpend"]))
// timeSpend records wall milliseconds from turn request to turn settlement at journal boundaries, including queueing and downtime; missing timestamps produce unknown totals.
export const timeSpend = NativeAtom.readable(get => {
  const next = get(spendRecords).read(["timeSpend"]), previous = Option.getOrUndefined(get.self<typeof next>())
  return next.map((value, index) => { const before = previous?.[index]; return before?.turnId === value.turnId && before.ms === value.ms ? before : value })
}).pipe(NativeAtom.keepAlive)
