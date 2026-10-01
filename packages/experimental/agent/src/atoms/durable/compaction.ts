import { RuntimeError, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { type Event, ModelCalled, ModelReturned, CompactionFailed, TurnSettled } from "../../contracts/events"

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

// createCompactionState constructs the durable summary state for a compaction projection.
export function createCompactionState() {
  return durableAtom({ name: "agent.compaction.state", input: Schema.Union([ModelCalled, ModelReturned, CompactionFailed, TurnSettled]), schema: CompactionState, initial: { through: 0, attempts: 0, summary: "", pending: null, failure: null }, reduce: compactState })
}
