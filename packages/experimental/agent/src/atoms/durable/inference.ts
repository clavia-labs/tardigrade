import { Schema } from "effect"
import { durableAtom, CoreEvent, RuntimeError, EffectRef, InvocationRef, effectKey, ExecutionResult, DeliverMessage } from "@clavia/tardigrade-experimental-core"
import { TurnRequested, ModelCalled, ModelFailed, ModelReturned, ToolReturned, TurnSettled, AbortRequested, type Event } from "../../contracts/events"

const Turn = Schema.Struct({
  turnId: Schema.String, invocationRef: Schema.NullOr(InvocationRef), settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled"])), answer: Schema.NullOr(Schema.String), answerCallId: Schema.NullOr(Schema.String),
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
  if (event.type === "TurnRequested") {
    if (turns.some(turn => turn.turnId === event.turnId)) throw new RuntimeError(`Duplicate turn: ${event.turnId}`)
    turns = [...turns, { turnId: event.turnId, invocationRef: event.invocationRef ?? null, settlement: null, answer: null, answerCallId: null, calls: [], outstanding: [], effects: [], failure: null, cancellation: null }]
  }
  if (event.type === "AbortRequested") turns = turns.map(turn => turn.invocationRef?.method === event.ref.method && turn.invocationRef.id === event.ref.id && turn.settlement === null && turn.cancellation === null ? { ...turn, cancellation: event.reason } : turn)
  if (event.type === "EffectRequested" && event.request.executor !== DeliverMessage.name) turns = turns.map(turn => turn.turnId === state.turnId ? { ...turn, effects: [...turn.effects, { ref: event.ref, pending: true }] } : turn)
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
    turns = turns.map(value => value === turn ? { ...value, settlement: event.outcome, ...(event.outcome === "failed" ? { failure: event.reason } : event.outcome === "cancelled" ? { cancellation: event.reason } : {}) } : value)
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

// turnOutput reads the answer of a completed turn.
export function turnOutput(events: readonly Event[], settlement: TurnSettled): string {
  if (settlement.outcome !== "completed") throw new RuntimeError(settlement.reason)
  if ("output" in settlement) return settlement.output
  const called = events.find(event => event.type === "ModelCalled" && event.purpose === "inference" && event.callId === settlement.callId && event.turnId === settlement.turnId)
  if (!called) throw new RuntimeError(`No matching model call for turn: ${settlement.turnId}`)
  const returned = events.find(event => event.type === "ModelReturned" && event.purpose === "inference" && event.callId === settlement.callId)
  if (!returned || returned.type !== "ModelReturned" || returned.purpose !== "inference") throw new RuntimeError(`Missing model result: ${settlement.callId}`)
  const reply = returned
  if (reply.toolCalls.length) throw new RuntimeError(`Model result still requests tools: ${settlement.callId}`)
  return reply.text
}

export const inferenceState = durableAtom({
  name: "agent.inference.state",
  input: Schema.Union([TurnRequested, ModelCalled, ModelFailed, ModelReturned, ToolReturned, TurnSettled, AbortRequested, CoreEvent]),
  schema: InferenceState,
  initial: initialInference,
  reduce: inferState,
})
