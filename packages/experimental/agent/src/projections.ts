import { RuntimeError, EffectRef, effectKey, ExecutionResult, type CoreEvent } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { ToolCall, Decision, BudgetDecision, PermissionPolicy, BudgetPolicy, BudgetMetric, PermissionAction, type Event, type MessageReceived } from "./event"

const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({ role: Schema.Literal("assistant"), text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ role: Schema.Literal("tool"), callId: Schema.String, providerId: Schema.String, name: Schema.String, text: Schema.String, error: Schema.Boolean }),
])
export const Conversation = Schema.Array(Message)
export const Trajectory = Schema.Array(Schema.Struct({ turnId: Schema.String, message: Message }))
export const TrajectoryState = Schema.Struct({
  entries: Trajectory,
  models: Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String })),
})

// inboxMessage selects messages that require an inference turn; replies resolve actor exchanges.
export function inboxMessage(event: MessageReceived): { readonly turnId: string; readonly text: string } | undefined {
  if (event.kind === "reply") return undefined
  if (event.kind === "message") return event
  return {
    turnId: `request:${JSON.stringify([event.handle, event.request.requestId])}`,
    text: `Child request (data): ${JSON.stringify({ handle: event.handle, ...event.request })}`,
  }
}

export function trajectoryState(state: typeof TrajectoryState.Type, event: Event): typeof TrajectoryState.Type {
  if (event.type === "MessageReceived") {
    const message = inboxMessage(event)
    return message ? { ...state, entries: [...state.entries, { turnId: message.turnId, message: { role: "user", text: message.text } }] } : state
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") return {
    ...state, models: [...state.models, { callId: event.callId, turnId: event.turnId }],
  }
  if (event.type === "ModelReturned" && event.purpose === "inference") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      entries: [...state.entries, { turnId: call.turnId, message: { role: "assistant", text: event.text, toolCalls: event.toolCalls } }],
      models: state.models.filter(value => value !== call),
    }
  }
  if (event.type === "ToolReturned") {
    const entry = state.entries.find(entry => entry.message.role === "assistant" && entry.message.toolCalls.some(call => call.callId === event.callId))
    const call = entry?.message.role === "assistant" ? entry.message.toolCalls.find(call => call.callId === event.callId) : undefined
    if (entry && call) return { ...state, entries: [...state.entries, { turnId: entry.turnId, message: { role: "tool", callId: event.callId, providerId: call.providerId, name: call.name, text: event.error ?? event.output, error: event.error !== null } }] }
  }
  if (event.type === "ModelFailed") return { ...state, models: state.models.filter(call => call.callId !== event.callId) }
  if (event.type === "TurnSettled") return { ...state, models: state.models.filter(call => call.turnId !== event.turnId) }
  return state
}

const Turn = Schema.Struct({
  turnId: Schema.String, settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled"])), answer: Schema.NullOr(Schema.String), answerCallId: Schema.NullOr(Schema.String),
  calls: Schema.Array(Schema.Struct({ callId: Schema.String, returned: Schema.Boolean })),
  outstanding: Schema.Array(Schema.String),
  effects: Schema.Array(Schema.Struct({ ref: EffectRef, pending: Schema.Boolean })), failure: Schema.NullOr(Schema.String), cancellation: Schema.NullOr(Schema.String),
})
export const InferenceState = Schema.Struct({
  turns: Schema.Array(Turn),
  turnId: Schema.String, callId: Schema.String, needsReply: Schema.Boolean, running: Schema.Boolean, waiting: Schema.Boolean,
})
export const initialInference: typeof InferenceState.Type = { turns: [], turnId: "", callId: "model::0", needsReply: false, running: false, waiting: false }

export function inferState(state: typeof InferenceState.Type, event: Event | CoreEvent): typeof InferenceState.Type {
  let turns = state.turns
  if (event.type === "MessageReceived") {
    const message = inboxMessage(event)
    if (!message) return state
    if (turns.some(turn => turn.turnId === message.turnId)) throw new RuntimeError(`Duplicate turn: ${message.turnId}`)
    turns = [...turns, { turnId: message.turnId, settlement: null, answer: null, answerCallId: null, calls: [], outstanding: [], effects: [], failure: null, cancellation: null }]
  }
  if (event.type === "AbortReceived") turns = turns.map(turn => turn.turnId === state.turnId && turn.cancellation === null ? { ...turn, cancellation: event.reason } : turn)
  if (event.type === "EffectRequested") turns = turns.map(turn => turn.turnId === state.turnId ? { ...turn, effects: [...turn.effects, { ref: event.ref, pending: true }] } : turn)
  if (event.type === "EffectCancelled" || event.type === "PromiseSettled" || (event.type === "EffectSettled" && (event.outcome.status === "rejected" || Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "value"))) {
    const key = effectKey(event.ref)
    turns = turns.map(turn => turn.effects.some(work => work.pending && effectKey(work.ref) === key) ? { ...turn, effects: turn.effects.map(work => effectKey(work.ref) === key ? { ...work, pending: false } : work) } : turn)
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
  if (event.type === "ModelFailed") {
    if (!state.running || event.callId !== state.callId) throw new RuntimeError(`No matching running model call: ${event.callId}`)
    turns = turns.map(turn => turn.calls.some(call => call.callId === event.callId) ? { ...turn, failure: event.reason, calls: turn.calls.map(call => call.callId === event.callId ? { ...call, returned: true } : call) } : turn)
  }
  if (event.type === "TurnSettled") {
    const turn = turns.find(turn => turn.turnId === event.turnId)
    if (!turn || turn.settlement !== null || event.turnId !== state.turnId) throw new RuntimeError(`No matching active turn: ${event.turnId}`)
    if (event.outcome === "completed" && (turn.answer === null || ("callId" in event ? turn.answerCallId !== event.callId : turn.answer !== event.output) || state.running || state.waiting)) {
      throw new RuntimeError(`Turn has no final answer: ${event.turnId}`)
    }
    if (event.outcome !== "completed" && turn.outstanding.length) throw new RuntimeError("Outstanding tools must settle before ending a turn")
    if (event.outcome === "cancelled" && (turn.cancellation === null || turn.effects.some(work => work.pending))) throw new RuntimeError("Turn cancellation must drain accepted work before settlement")
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
  through: Schema.Finite, attempts: Schema.Finite, summary: Schema.String, failure: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.Struct({ callId: Schema.String, through: Schema.Finite })),
})
export function compactState(state: typeof CompactionState.Type, event: Event): typeof CompactionState.Type {
  if (event.type === "TurnSettled" && state.failure !== null) return { ...state, failure: null }
  if (event.type === "CompactionFailed") {
    if (state.pending?.callId !== event.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { ...state, pending: null, failure: event.reason }
  }
  if (event.type === "ModelCalled" && event.purpose === "compaction") {
    if (state.pending || !Number.isSafeInteger(event.through) || event.through <= state.through) throw new RuntimeError(`Compaction call is unavailable: ${event.callId}`)
    return { ...state, attempts: state.attempts + 1, pending: { callId: event.callId, through: event.through } }
  }
  if (event.type === "ModelReturned" && event.purpose === "compaction") {
    if (!state.pending || event.callId !== state.pending.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { ...state, through: state.pending.through, summary: event.text, pending: null, failure: null }
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
    if (!state.some(entry => entry.turnId !== event.turnId)) return state
    return state.map(entry => entry.turnId !== event.turnId
      ? { ...entry, turnId: event.turnId, granted: 0, decisions: [] } : entry)
  }
  if (event.type === "TurnSettled") {
    if (!state.some(entry => entry.turnId === event.turnId)) return state
    return state.map(entry => {
      if (entry.turnId !== event.turnId) return entry
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
