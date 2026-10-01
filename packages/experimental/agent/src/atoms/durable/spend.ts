import { atom, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { MessageReceived, ModelCalled, ModelReturned, ToolCalled, ToolReturned, TurnSettled, CompactionFailed } from "../../event"
import { inboxMessage } from "../../projections"

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const ToolSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, count: Count }))
const TokenSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, input: Count, output: Count }))
const UsdSpend = Schema.Array(Schema.Struct({ turnId: Schema.String, usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) }))
const Calls = Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String }))
const SpendState = Schema.Struct({
  toolSpend: ToolSpend, tokenSpend: TokenSpend, usdSpend: UsdSpend,
  turns: Schema.Array(Schema.String), models: Calls, tools: Calls,
})
const SpendEvent = Schema.Union([MessageReceived, ModelCalled, ModelReturned, ToolCalled, ToolReturned, TurnSettled, CompactionFailed])

// spendState retains pending call attribution alongside ordered turn totals across checkpoint recovery.
function spendState(state: typeof SpendState.Type, event: typeof SpendEvent.Type): typeof SpendState.Type {
  if (event.type === "MessageReceived") {
    const message = inboxMessage(event)
    if (!message || state.toolSpend.some(turn => turn.turnId === message.turnId)) return state
    const turnId = message.turnId
    return {
      ...state, turns: [...state.turns, turnId],
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
  if (event.type === "CompactionFailed") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      ...state, models: state.models.filter(value => value !== call),
      usdSpend: state.usdSpend.map(turn => turn.turnId === call.turnId ? { ...turn, usd: null } : turn),
    }
  }
  return {
    ...state, turns: state.turns.filter(turnId => turnId !== event.turnId),
    models: state.models.filter(call => call.turnId !== event.turnId),
    tools: state.tools.filter(call => call.turnId !== event.turnId),
    usdSpend: state.models.some(call => call.turnId === event.turnId)
      ? state.usdSpend.map(turn => turn.turnId === event.turnId ? { ...turn, usd: null } : turn) : state.usdSpend,
  }
}

const spend = durableAtom({
  name: "agent.spend", input: SpendEvent, schema: SpendState,
  initial: { toolSpend: [], tokenSpend: [], usdSpend: [], turns: [], models: [], tools: [] }, reduce: spendState,
})

// toolSpend records budget-counted tool calls per turn, including execution failures.
export const toolSpend = atom(get => get(spend).toolSpend)
// tokenSpend sums recorded provider input and output tokens per turn, including compaction.
export const tokenSpend = atom(get => get(spend).tokenSpend)
// usdSpend sums reported provider costs per turn; a missing cost makes that turn's total unknown.
export const usdSpend = atom(get => get(spend).usdSpend)
