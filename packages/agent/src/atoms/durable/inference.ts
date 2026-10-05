import { Schema } from "effect"
import { durableAtom, ObservedCoreEvent, RuntimeError, EffectRef, InvocationRef, effectKey, ExecutionResult, DeliverMessage } from "@clavia/tardigrade-core"
import { TurnRequested, ModelCalled, ModelFailed, ModelReturned, OutputRejected, ToolReturned, TurnSettled, AbortRequested, type Event } from "../../contracts/events"

const Turn = Schema.Struct({
  turnId: Schema.String, invocationRef: Schema.NullOr(InvocationRef), settlement: Schema.NullOr(Schema.Literals(["completed", "failed", "cancelled"])), answer: Schema.NullOr(Schema.String), answerCallId: Schema.NullOr(Schema.String),
  rejection: Schema.optionalKey(Schema.NullOr(Schema.Struct({ contract: Schema.String, errors: Schema.Array(Schema.String), attempt: Schema.Finite, maxCorrections: Schema.Finite }))),
  calls: Schema.Array(Schema.Struct({ callId: Schema.String, returned: Schema.Boolean })),
  outstanding: Schema.Array(Schema.String),
  effects: Schema.Array(Schema.Struct({ ref: EffectRef, pending: Schema.Boolean })), failure: Schema.NullOr(Schema.String), cancellation: Schema.NullOr(Schema.String),
})
export const InferenceState = Schema.Struct({
  turns: Schema.Array(Turn),
  turnId: Schema.String, callId: Schema.String, origin: Schema.NullOr(Schema.Finite), needsReply: Schema.Boolean, running: Schema.Boolean, waiting: Schema.Boolean,
})
export const initialInference: typeof InferenceState.Type = { turns: [], turnId: "", callId: "model::0", origin: null, needsReply: false, running: false, waiting: false }

type Turn = typeof InferenceState.Type["turns"][number]
// updateTurn replaces the last turn that matches; each caller matches an identifier at most one turn holds (turn ids and invocation refs are checked unique per turn, effect refs and call ids are unique per effect), so this equals replacing every match.
const updateTurn = (turns: typeof InferenceState.Type["turns"], matches: (turn: Turn) => boolean, update: (turn: Turn) => Turn) => {
  for (let index = turns.length - 1; index >= 0; index--) {
    if (!matches(turns[index]!)) continue
    const next = turns.slice()
    next[index] = update(turns[index]!)
    return next
  }
  return turns
}

export function inferState(state: typeof InferenceState.Type, event: Event | ObservedCoreEvent, _metadata?: unknown, position?: number): typeof InferenceState.Type {
  let turns = state.turns
  if (event.type === "TurnRequested") {
    if (turns.some(turn => turn.turnId === event.turnId)) throw new RuntimeError(`Duplicate turn: ${event.turnId}`)
    // An invocation starts at most one turn, so AbortRequested cancels exactly the turn of its invocation.
    const ref = event.invocationRef
    if (ref && turns.some(turn => turn.invocationRef?.method === ref.method && turn.invocationRef.id === ref.id)) throw new RuntimeError(`Duplicate turn for invocation: ${ref.method}:${ref.id}`)
    turns = [...turns, { turnId: event.turnId, invocationRef: event.invocationRef ?? null, settlement: null, answer: null, answerCallId: null, rejection: null, calls: [], outstanding: [], effects: [], failure: null, cancellation: null }]
  }
  if (event.type === "AbortRequested") turns = updateTurn(turns, turn => turn.invocationRef?.method === event.ref.method && turn.invocationRef.id === event.ref.id && turn.settlement === null && turn.cancellation === null, turn => ({ ...turn, cancellation: event.reason }))
  if (event.type === "EffectRequested" && event.act !== DeliverMessage.name) turns = updateTurn(turns, turn => turn.turnId === state.turnId, turn => ({ ...turn, effects: [...turn.effects, { ref: event.ref, pending: true }] }))
  if (event.type === "EffectCancelled" || event.type === "PromiseSettled" || (event.type === "EffectSettled" && (event.outcome.status === "rejected" || Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value).type === "value"))) {
    const key = effectKey(event.ref)
    const settles = (work: Turn["effects"][number]) => work.ref.seq === event.ref.seq && effectKey(work.ref) === key
    turns = updateTurn(turns, turn => turn.effects.some(work => work.pending && settles(work)), turn => ({ ...turn, effects: turn.effects.map(work => settles(work) ? { ...work, pending: false } : work) }))
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") {
    if (!state.needsReply || state.running || state.waiting || event.turnId !== state.turnId || event.callId !== state.callId) {
      throw new RuntimeError(`Model call is unavailable: ${event.callId}`)
    }
    turns = updateTurn(turns, turn => turn.turnId === event.turnId, turn => ({ ...turn, calls: [...turn.calls, { callId: event.callId, returned: false }] }))
  }
  if (event.type === "ModelReturned" && event.purpose === "inference") {
    if (!state.running || event.callId !== state.callId) throw new RuntimeError(`No matching running model call: ${event.callId}`)
    if (new Set(event.toolCalls.map(call => call.callId)).size !== event.toolCalls.length) throw new RuntimeError("Duplicate tool call IDs in model reply")
    turns = updateTurn(turns, turn => turn.calls.some(call => call.callId === event.callId), turn => ({
      ...turn, answer: event.toolCalls.length === 0 ? event.text : null, rejection: null,
      answerCallId: event.toolCalls.length === 0 ? event.callId : null,
      calls: turn.calls.map(call => call.callId === event.callId ? { ...call, returned: true } : call),
      outstanding: event.toolCalls.map(call => call.callId),
    }))
  }
  if (event.type === "ModelFailed") {
    if (!state.running || event.callId !== state.callId) throw new RuntimeError(`No matching running model call: ${event.callId}`)
    turns = updateTurn(turns, turn => turn.calls.some(call => call.callId === event.callId), turn => ({ ...turn, failure: event.reason, calls: turn.calls.map(call => call.callId === event.callId ? { ...call, returned: true } : call) }))
  }
  if (event.type === "OutputRejected") {
    if (!state.running || event.callId !== state.callId) throw new RuntimeError(`No matching running model call: ${event.callId}`)
    turns = turns.map(turn => turn.turnId === event.turnId ? {
      ...turn, rejection: { contract: event.contract, errors: event.errors, attempt: event.attempt, maxCorrections: event.maxCorrections },
      ...(event.attempt >= event.maxCorrections ? { failure: `The response did not satisfy output contract "${event.contract}" after ${event.maxCorrections} correction${event.maxCorrections === 1 ? "" : "s"}` } : {}),
      calls: turn.calls.map(call => call.callId === event.callId ? { ...call, returned: true } : call),
    } : turn)
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
  if (event.type === "ToolReturned") turns = updateTurn(turns, turn => turn.outstanding.includes(event.callId), turn => ({ ...turn, outstanding: turn.outstanding.filter(id => id !== event.callId) }))
  if (turns === state.turns) return state
  const turn = turns.find(turn => turn.settlement === null)
  const running = turn?.calls.find(call => !call.returned)
  const turnId = turn?.turnId ?? ""
  const callId = running?.callId ?? `model:${turnId}:${turn?.calls.length ?? 0}`
  return { turns, turnId, callId, origin: callId === state.callId ? state.origin : position ?? null, needsReply: turn !== undefined && turn.answer === null, running: running !== undefined, waiting: (turn?.outstanding.length ?? 0) > 0 }
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
  input: Schema.Union([TurnRequested, ModelCalled, ModelFailed, ModelReturned, OutputRejected, ToolReturned, TurnSettled, AbortRequested, ObservedCoreEvent]),
  schema: InferenceState,
  initial: initialInference,
  reduce: inferState,
})
