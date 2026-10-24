import { RuntimeError, durableAtom } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ModelRef } from "@clavia/tardigrade-model/reference"
import { type Event, ModelCalled, ModelReturned, ModelFailed, ModelUpdated, OutputRejected, TurnRequested, ToolReturned, CompactionFailed, TurnSettled } from "../../contracts/events"

const Cursor = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
// UsageAnchor measures context through an assistant reply; after counts later trajectory messages for array inputs (platform/test/bun/agent-compaction.test.ts).
const UsageAnchor = Schema.Struct({ tokens: Cursor, position: Cursor, after: Cursor, through: Cursor, model: ModelRef })
const UsageCall = Schema.Struct({ callId: Schema.String, through: Cursor, model: ModelRef })

export const CompactionState = Schema.Struct({
  origin: Schema.NullOr(Schema.Finite), through: Schema.Finite, cursor: Schema.optionalKey(Schema.NullOr(Cursor)), attempts: Schema.Finite, summary: Schema.String, failure: Schema.NullOr(Schema.String),
  pending: Schema.NullOr(Schema.Struct({ callId: Schema.String, through: Schema.Finite, cursor: Schema.optionalKey(Cursor) })),
  usageAnchor: Schema.optionalKey(Schema.NullOr(UsageAnchor)),
  usageCall: Schema.optionalKey(Schema.NullOr(UsageCall)),
})
export function compactState(state: typeof CompactionState.Type, event: Event, _metadata?: unknown, position?: number): typeof CompactionState.Type {
  if (event.type === "ModelUpdated") state = { ...state, usageAnchor: null, usageCall: null }
  if (state.usageAnchor && (event.type === "TurnRequested" || event.type === "ToolReturned" || (event.type === "ModelReturned" && event.purpose === "inference"))) {
    state = { ...state, usageAnchor: { ...state.usageAnchor, after: state.usageAnchor.after + 1 } }
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") {
    state = { ...state, usageCall: { callId: event.callId, through: state.through, model: event.model } }
  }
  if ((event.type === "ModelReturned" && event.purpose === "inference") || event.type === "ModelFailed" || event.type === "OutputRejected") {
    const call = state.usageCall
    if (call?.callId === event.callId) {
      const tokens = event.type === "ModelReturned" && event.usage?.input !== undefined ? event.usage.input + (event.usage.output ?? 0) : undefined
      state = { ...state, usageCall: null, ...(tokens !== undefined && Number.isSafeInteger(tokens) && position !== undefined ? {
        usageAnchor: { tokens, position, after: 0, through: call.through, model: call.model },
      } : {}) }
    }
  }
  if (position !== undefined && (event.type === "TurnSettled" || event.type === "ModelReturned" || event.type === "CompactionFailed")) state = { ...state, origin: position }
  if (event.type === "TurnSettled" && state.failure !== null) return { ...state, failure: null }
  if (event.type === "CompactionFailed") {
    if (state.pending?.callId !== event.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { ...state, pending: null, failure: event.reason }
  }
  if (event.type === "ModelCalled" && event.purpose === "compaction") {
    if (state.pending || !Number.isSafeInteger(event.through) || event.through <= state.through || (event.cursor !== undefined && event.cursor <= (state.cursor ?? 0))) throw new RuntimeError(`Compaction call is unavailable: ${event.callId}`)
    return { ...state, attempts: state.attempts + 1, pending: { callId: event.callId, through: event.through, ...(event.cursor === undefined ? {} : { cursor: event.cursor }) } }
  }
  if (event.type === "ModelReturned" && event.purpose === "compaction") {
    if (!state.pending || event.callId !== state.pending.callId) throw new RuntimeError(`No matching running compaction: ${event.callId}`)
    return { ...state, through: state.pending.through, cursor: state.pending.cursor ?? null, summary: event.text, pending: null, failure: null }
  }
  return state
}

// createCompactionState constructs the durable summary state for a compaction projection.
export function createCompactionState() {
  return durableAtom({ name: "agent.compaction.state", input: Schema.Union([ModelCalled, ModelReturned, ModelFailed, ModelUpdated, OutputRejected, TurnRequested, ToolReturned, CompactionFailed, TurnSettled]), schema: CompactionState, initial: { origin: null, through: 0, attempts: 0, summary: "", pending: null, failure: null }, reduce: compactState })
}
