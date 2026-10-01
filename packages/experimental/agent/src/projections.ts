import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { ToolCall, Decision, BudgetDecision, PermissionPolicy, BudgetPolicy, BudgetMetric, PermissionAction, type Event, type MessageReceived } from "./event"

const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({ role: Schema.Literal("assistant"), text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ role: Schema.Literal("tool"), callId: Schema.String, providerId: Schema.String, name: Schema.String, text: Schema.String, error: Schema.Boolean }),
])
export const Conversation = Schema.Array(Message)

// inboxMessage selects messages that require an inference turn; replies resolve actor exchanges.
export function inboxMessage(event: MessageReceived): { readonly turnId: string; readonly text: string } | undefined {
  if (event.kind === "reply") return undefined
  if (event.kind === "message") return event
  return {
    turnId: `request:${JSON.stringify([event.handle, event.request.requestId])}`,
    text: `Child request (data): ${JSON.stringify({ handle: event.handle, ...event.request })}`,
  }
}

export function trajectoryState(state: typeof Conversation.Type, event: Event): typeof Conversation.Type {
  if (event.type === "MessageReceived") {
    const message = inboxMessage(event)
    return message ? [...state, { role: "user", text: message.text }] : state
  }
  if (event.type === "ModelReturned" && event.purpose === "inference") return [...state, { role: "assistant", text: event.text, toolCalls: event.toolCalls }]
  if (event.type === "ToolReturned") {
    const call = state.flatMap(message => message.role === "assistant" ? message.toolCalls : []).find(call => call.callId === event.callId)
    if (call) return [...state, { role: "tool", callId: event.callId, providerId: call.providerId, name: call.name, text: event.error ?? event.output, error: event.error !== null }]
  }
  return state
}

const Turn = Schema.Struct({
  turnId: Schema.String, settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled"])), answer: Schema.NullOr(Schema.String), answerCallId: Schema.NullOr(Schema.String),
  calls: Schema.Array(Schema.Struct({ callId: Schema.String, returned: Schema.Boolean })),
  outstanding: Schema.Array(Schema.String),
})
export const InferenceState = Schema.Struct({
  turns: Schema.Array(Turn),
  turnId: Schema.String, callId: Schema.String, needsReply: Schema.Boolean, running: Schema.Boolean, waiting: Schema.Boolean,
})
export const initialInference: typeof InferenceState.Type = { turns: [], turnId: "", callId: "model::0", needsReply: false, running: false, waiting: false }

export function inferState(state: typeof InferenceState.Type, event: Event): typeof InferenceState.Type {
  let turns = state.turns
  if (event.type === "MessageReceived") {
    const message = inboxMessage(event)
    if (!message) return state
    if (turns.some(turn => turn.turnId === message.turnId)) throw new RuntimeError(`Duplicate turn: ${message.turnId}`)
    turns = [...turns, { turnId: message.turnId, settlement: null, answer: null, answerCallId: null, calls: [], outstanding: [] }]
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") {
    if (!state.needsReply || state.running || state.waiting || event.turnId !== state.turnId || event.callId !== state.callId) {
      throw new RuntimeError(`Model call is unavailable: ${event.callId}`)
    }
    turns = turns.map(turn => turn.turnId === event.turnId ? { ...turn, calls: [...turn.calls, { callId: event.callId, returned: false }] } : turn)
  }
  if (event.type === "ModelReturned" && event.purpose === "inference") {
    if (!state.running || event.callId !== state.callId) throw new RuntimeError(`No matching running model call: ${event.callId}`)
    if (new Set(event.toolCalls.map(call => call.callId)).size !== event.toolCalls.length) throw new RuntimeError("Duplicate tool call IDs in model reply")
    turns = turns.map(turn => turn.calls.some(call => call.callId === event.callId) ? {
      ...turn, answer: event.toolCalls.length === 0 ? event.text : null,
      answerCallId: event.toolCalls.length === 0 ? event.callId : null,
      calls: turn.calls.map(call => call.callId === event.callId ? { ...call, returned: true } : call),
      outstanding: event.toolCalls.map(call => call.callId),
    } : turn)
  }
  if (event.type === "TurnSettled") {
    const turn = turns.find(turn => turn.turnId === event.turnId)
    if (!turn || turn.settlement !== null || event.turnId !== state.turnId) throw new RuntimeError(`No matching active turn: ${event.turnId}`)
    if (event.outcome === "completed" && (turn.answer === null || ("callId" in event ? turn.answerCallId !== event.callId : turn.answer !== event.output) || state.running || state.waiting)) {
      throw new RuntimeError(`Turn has no final answer: ${event.turnId}`)
    }
    if (event.outcome !== "completed" && turn.outstanding.length) throw new RuntimeError("Outstanding tools must settle before ending a turn")
    turns = turns.map(value => value === turn ? { ...value, settlement: event.outcome } : value)
  }
  if (event.type === "ToolReturned" && turns.some(turn => turn.outstanding.includes(event.callId))) {
    turns = turns.map(turn => turn.outstanding.includes(event.callId)
      ? { ...turn, outstanding: turn.outstanding.filter(id => id !== event.callId) }
      : turn)
  }
  if (turns === state.turns) return state
  const turn = turns.find(turn => turn.settlement === null)
  const running = turn?.calls.find(call => !call.returned)
  const turnId = turn?.turnId ?? ""
  return { turns, turnId, callId: running?.callId ?? `model:${turnId}:${turn?.calls.length ?? 0}`, needsReply: turn !== undefined && turn.answer === null, running: running !== undefined, waiting: (turn?.outstanding.length ?? 0) > 0 }
}

export const CompactionState = Schema.Struct({
  through: Schema.Finite, summary: Schema.String, failure: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.Struct({ callId: Schema.String, through: Schema.Finite })),
})
export function compactState(state: typeof CompactionState.Type, event: Event): typeof CompactionState.Type {
  if (event.type === "CompactionFailed") {
    if (state.pending?.callId !== event.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { ...state, pending: null, failure: event.reason }
  }
  if (event.type === "ModelCalled" && event.purpose === "compaction") {
    if (state.pending || !Number.isSafeInteger(event.through) || event.through <= state.through) throw new RuntimeError(`Compaction call is unavailable: ${event.callId}`)
    return { ...state, pending: { callId: event.callId, through: event.through } }
  }
  if (event.type === "ModelReturned" && event.purpose === "compaction") {
    if (!state.pending || event.callId !== state.pending.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { through: state.pending.through, summary: event.text, pending: null, failure: null }
  }
  return state
}

export const ToolState = Schema.Struct({
  queue: Schema.Array(Schema.Struct({ call: ToolCall, running: Schema.Boolean })),
  pending: Schema.NullOr(ToolCall), running: Schema.Boolean,
})
export function toolState(state: typeof ToolState.Type, event: Event): typeof ToolState.Type {
  let queue = state.queue
  if (event.type === "ModelReturned" && event.purpose === "inference" && event.toolCalls.length > 0) queue = [...queue, ...event.toolCalls.map(call => ({ call, running: false }))]
  if (event.type === "ToolCalled" && queue.some(item => item.call.callId === event.callId && !item.running)) queue = queue.map(item => item.call.callId === event.callId && !item.running ? { ...item, running: true } : item)
  if (event.type === "ToolReturned" && queue.some(item => item.call.callId === event.callId)) queue = queue.filter(item => item.call.callId !== event.callId)
  return queue === state.queue ? state : { queue, pending: queue[0]?.call ?? null, running: queue[0]?.running ?? false }
}

export const PermissionState = Schema.Struct({ policy: Schema.NullOr(PermissionPolicy), decisions: Schema.Array(Schema.Struct({ action: PermissionAction, requestId: Schema.NonEmptyString, decision: Decision })) })
export function permissionState(state: typeof PermissionState.Type, event: Event): typeof PermissionState.Type {
  if (event.type === "PermissionConfigured") {
    if (state.policy) throw new RuntimeError("Permission policy is already configured")
    return { ...state, policy: event.policy }
  }
  if (event.type === "PermissionUpdated") {
    if (!state.policy) throw new RuntimeError("Permission policy is not configured")
    return { ...state, policy: event.policy }
  }
  if (event.type === "PermissionResolved") {
    const prior = state.decisions.findLast(value => value.action === event.action && value.requestId === event.requestId)?.decision
    if (prior?.allowed === event.decision.allowed && prior.reason === event.decision.reason) return state
    return { ...state, decisions: [...state.decisions, { action: event.action, requestId: event.requestId, decision: event.decision }] }
  }
  return state
}

export const BudgetState = Schema.Array(Schema.Struct({
  metric: BudgetMetric, turnId: Schema.optionalKey(Schema.String), policy: BudgetPolicy, granted: Schema.Finite,
  decisions: Schema.Array(Schema.Struct({ callId: Schema.String, decision: BudgetDecision })),
}))

function validateBudgetAmount(metric: string, amount: number) {
  if (!Number.isFinite(amount) || (metric === "toolCalls" && !Number.isSafeInteger(amount))) throw new RuntimeError(`Invalid budget amount for ${metric}`)
}

export function budgetState(state: typeof BudgetState.Type, event: Event): typeof BudgetState.Type {
  if (event.type === "BudgetConfigured" || event.type === "BudgetUpdated") {
    const prior = state.find(entry => entry.metric === event.metric)
    if (event.type === "BudgetConfigured" && prior) throw new RuntimeError(`Budget policy is already configured: ${event.metric}`)
    if (event.type === "BudgetUpdated" && !prior) throw new RuntimeError(`Budget policy is not configured: ${event.metric}`)
    validateBudgetAmount(event.metric, event.policy.limit)
    validateBudgetAmount(event.metric, event.policy.limit + (prior?.granted ?? 0))
    return prior ? state.map(entry => entry === prior ? { ...entry, policy: event.policy } : entry)
      : [...state, { metric: event.metric, policy: event.policy, granted: 0, decisions: [] }]
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") {
    if (!state.some(entry => entry.policy.scope === "turn" && entry.turnId !== event.turnId)) return state
    return state.map(entry => entry.policy.scope === "turn" && entry.turnId !== event.turnId
      ? { ...entry, turnId: event.turnId, granted: 0, decisions: [] } : entry)
  }
  if (event.type === "TurnSettled") {
    if (!state.some(entry => entry.policy.scope === "turn" && entry.turnId === event.turnId)) return state
    return state.map(entry => {
      if (entry.policy.scope !== "turn" || entry.turnId !== event.turnId) return entry
      const { turnId: _turnId, ...retained } = entry
      return { ...retained, granted: 0, decisions: [] }
    })
  }
  if (event.type === "BudgetResolved") {
    const budget = state.find(entry => entry.metric === event.metric)
    if (!budget) throw new RuntimeError(`Budget policy is not configured: ${event.metric}`)
    const prior = budget.decisions.find(value => value.callId === event.callId)
    if (prior) {
      const same = prior.decision.allowed
        ? event.decision.allowed && prior.decision.additional === event.decision.additional
        : !event.decision.allowed && prior.decision.reason === event.decision.reason
      if (!same) throw new RuntimeError(`Conflicting budget resolution: ${event.metric}:${event.callId}`)
      return state
    }
    if (event.decision.allowed) validateBudgetAmount(event.metric, event.decision.additional)
    const granted = budget.granted + (event.decision.allowed ? event.decision.additional : 0)
    validateBudgetAmount(event.metric, granted)
    validateBudgetAmount(event.metric, granted + budget.policy.limit)
    return state.map(entry => entry === budget ? { ...entry, granted, decisions: [...entry.decisions, { callId: event.callId, decision: event.decision }] } : entry)
  }
  return state
}
