import { atom, keyValue, tree, durableAtom, ObservedCoreEvent } from "@clavia/tardigrade-core"
import { Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { Event } from "../../contracts/events"

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const ToolSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, count: Count }))
const TokenSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, input: Count, output: Count }))
const UsdSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }))
const TimeSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, ms: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }))
const Calls = Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String }))
const SpendState = Schema.Struct({
  toolSpend: ToolSpend, tokenSpend: TokenSpend, usdSpend: UsdSpend, timeSpend: TimeSpend, timers: Schema.Array(Schema.Struct({ turnId: Schema.String, index: Count, startedAt: Schema.NullOr(Count) })),
  turns: Schema.Array(Schema.String), models: Calls, tools: Calls,
})
const SpendEvent = Schema.Union([Event, ObservedCoreEvent])

const Spend = Schema.Struct({ turnId: Schema.String, count: Count, input: Count, output: Count, usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), ms: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))), startedAt: Schema.NullOr(Count) })
export const SpendCollections = Schema.Struct({ totals: keyValue(Spend), pending: tree(Schema.Array(Schema.String)), models: keyValue(Schema.String), tools: keyValue(Schema.String) })
export const spendRecords = durableAtom({
  name: "agent.spend", input: SpendEvent, schema: SpendCollections,
  initial: { totals: {}, pending: [], models: {}, tools: {} },
  migrate: value => {
    if (Schema.is(SpendCollections)(value)) return value
    const state = Schema.decodeUnknownSync(SpendState)(value)
    return { totals: Object.fromEntries(state.toolSpend.map(tool => [JSON.stringify(tool.turnId), { ...tool, input: state.tokenSpend.find(turn => turn.turnId === tool.turnId)?.input ?? 0, output: state.tokenSpend.find(turn => turn.turnId === tool.turnId)?.output ?? 0, usd: state.usdSpend.find(turn => turn.turnId === tool.turnId)?.usd ?? null, ms: state.timeSpend.find(turn => turn.turnId === tool.turnId)?.ms ?? null, startedAt: state.timers.find(turn => turn.turnId === tool.turnId)?.startedAt ?? null }])), pending: state.turns, models: Object.fromEntries(state.models.map(call => [call.callId, call.turnId])), tools: Object.fromEntries(state.tools.map(call => [call.callId, call.turnId])) }
  },
  reduce: (state, event, metadata) => {
    const pending = state.read(["pending"])
    if (metadata.recordedAt !== undefined) for (const id of pending) {
      const turn = state.read(["totals", JSON.stringify(id)])
      if (turn.startedAt !== null) { const ms = Math.max(0, metadata.recordedAt - turn.startedAt); if (ms !== turn.ms) state = state.set(["totals", JSON.stringify(id)], { ...turn, ms }) }
    }
    if (event.type === "TurnRequested") {
      if (state.has(["totals", JSON.stringify(event.turnId)])) return state
      return state.batch(edit => {
        edit.set(["totals", JSON.stringify(event.turnId)], { turnId: event.turnId, count: 0, input: 0, output: 0, usd: 0, ms: metadata.recordedAt === undefined ? null : 0, startedAt: metadata.recordedAt ?? null })
        edit.set(["pending"], [...pending, event.turnId])
      })
    }
    if (event.type === "ModelCalled") {
      const id = event.purpose === "inference" ? event.turnId : pending[0]
      return id === undefined || state.has(["models", event.callId]) ? state : state.set(["models", event.callId], id)
    }
    if (event.type === "ModelReturned" || event.type === "ModelFailed" || event.type === "CompactionFailed") {
      if (!state.has(["models", event.callId])) return state
      const id = state.read(["models", event.callId]), turn = state.has(["totals", JSON.stringify(id)]) ? state.read(["totals", JSON.stringify(id)]) : undefined
      return state.batch(edit => {
        edit.remove(["models", event.callId])
        if (event.type === "ModelReturned") {
          if (event.purpose === "inference") for (const call of event.toolCalls) edit.set(["tools", call.callId], id)
          if (turn) edit.set(["totals", JSON.stringify(id)], { ...turn, input: turn.input + (event.usage?.input ?? 0), output: turn.output + (event.usage?.output ?? 0), usd: turn.usd === null || event.usage?.usd == null ? null : turn.usd + event.usage.usd })
        } else if (turn) edit.set(["totals", JSON.stringify(id)], { ...turn, usd: null })
      })
    }
    if (event.type === "ToolCalled" || event.type === "ToolReturned") {
      if (!state.has(["tools", event.callId])) return state
      const id = state.read(["tools", event.callId])
      return state.batch(edit => {
        edit.remove(["tools", event.callId])
        if (event.type === "ToolCalled" && event.counted && state.has(["totals", JSON.stringify(id)])) { const turn = state.read(["totals", JSON.stringify(id)]); edit.set(["totals", JSON.stringify(id)], { ...turn, count: turn.count + 1 }) }
      })
    }
    if (event.type !== "TurnSettled") return state
    const models = Object.entries(state.read(["models"])), tools = Object.entries(state.read(["tools"]))
    return state.batch(edit => {
      edit.set(["pending"], pending.filter(id => id !== event.turnId))
      for (const [key, id] of models) if (id === event.turnId) edit.remove(["models", key])
      for (const [key, id] of tools) if (id === event.turnId) edit.remove(["tools", key])
      if (state.has(["totals", JSON.stringify(event.turnId)])) {
        const turn = state.read(["totals", JSON.stringify(event.turnId)])
        edit.set(["totals", JSON.stringify(event.turnId)], { ...turn, startedAt: null, ms: pending.includes(event.turnId) && (metadata.recordedAt === undefined || turn.startedAt === null) ? null : turn.ms, usd: models.some(([, id]) => id === event.turnId) ? null : turn.usd })
      }
    })
  },
})

export const spendState = atom(get => {
  const state = get(spendRecords), totals = Object.values(state.read(["totals"])), pending = state.read(["pending"])
  return { toolSpend: totals.map(({ turnId, count }) => ({ turnId, count })), tokenSpend: totals.map(({ turnId, input, output }) => ({ turnId, input, output })), usdSpend: totals.map(({ turnId, usd }) => ({ turnId, usd })), timeSpend: totals.map(({ turnId, ms }) => ({ turnId, ms })), turns: pending,
    timers: pending.map(turnId => ({ turnId, index: totals.findIndex(turn => turn.turnId === turnId), startedAt: state.read(["totals", JSON.stringify(turnId)]).startedAt })),
    models: Object.entries(state.read(["models"])).map(([callId, turnId]) => ({ callId, turnId })), tools: Object.entries(state.read(["tools"])).map(([callId, turnId]) => ({ callId, turnId })),
  }
})

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
