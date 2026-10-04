import { MethodRequested, MethodReturned, CodeCalled, CodeReturned, DomainEvent, EvaluateCode, ExecutePackage, type Event } from "../../contracts/code-mode"
import { Schema } from "effect"
import { EffectRef, durableAtom, effectKey, RuntimeError, EffectAcceptance, type RecordMetadata } from "@clavia/tardigrade-core"
import { ToolCall, ToolCalled, ModelReturned, ToolReturned } from "../../contracts/events"

const Position = EffectRef.fields.seq
const MethodRecord = Schema.Struct({ origin: Position, ordinal: MethodRequested.fields.ordinal, package: MethodRequested.fields.package, method: MethodRequested.fields.method, input: MethodRequested.fields.input, ref: Schema.NullOr(EffectRef), outcome: Schema.NullOr(MethodReturned.fields.outcome) })
export const CodeModeState = Schema.Array(Schema.Struct({ call: ToolCall, origin: Schema.NullOr(Position), codeMode: Schema.NullOr(Schema.String), evaluation: Schema.NullOr(EffectRef), ambient: Schema.NullOr(CodeCalled.fields.ambient), returned: Schema.Boolean, calls: Schema.Array(MethodRecord), outcome: Schema.NullOr(CodeReturned.fields.outcome) }))

// codeModeState retains code inputs and method receipts until their tool results are delivered.
export function codeModeState(state: typeof CodeModeState.Type, event: typeof Event.Type | EffectAcceptance, _metadata: RecordMetadata = {}, position?: number): typeof CodeModeState.Type {
  if (event.type === "ModelReturned" && event.purpose === "inference") return [...state, ...event.toolCalls.map(call => ({ call, origin: null, codeMode: null, evaluation: null, ambient: null, returned: false, calls: [], outcome: null }))]
  if (event.type === "ToolReturned") return state.flatMap(entry => entry.call.callId !== event.callId ? [entry]
    : entry.calls.every(call => call.outcome !== null) ? [] : [{ ...entry, returned: true }])
  if (event.type === "ToolCalled") {
    if (event.codeMode === undefined) return state
    if (position === undefined) throw new RuntimeError("Code request requires a journal position")
    const entry = state.find(entry => entry.call.callId === event.callId)
    if (!entry || entry.origin !== null) throw new RuntimeError("No pending code request")
    return state.map(value => value === entry ? { ...entry, origin: position, codeMode: event.codeMode! } : value)
  }
  if (event.type === "EffectRequested") {
    if (event.act === EvaluateCode.name) {
      const entry = state.find(entry => entry.origin === event.origin)
      if (!entry || entry.outcome !== null || entry.evaluation !== null) throw new RuntimeError("No pending code evaluation")
      return state.map(value => value === entry ? { ...entry, evaluation: event.ref } : value)
    }
    if (event.act !== ExecutePackage.name) return state
    const entry = state.find(entry => entry.calls.some(call => call.origin === event.origin))
    const call = entry?.calls.find(call => call.origin === event.origin)
    if (!entry || !call || call.ref !== null || call.outcome !== null) throw new RuntimeError("No pending package acceptance")
    return state.map(value => value === entry ? { ...entry, calls: entry.calls.map(value => value === call ? { ...call, ref: event.ref } : value) } : value)
  }
  if (!("codeMode" in event)) return state
  const entry = state.find(entry => entry.call.callId === event.callId && entry.codeMode === event.codeMode)
  if (!entry || (entry.outcome !== null && event.type !== "MethodReturned")) throw new RuntimeError(`No pending code execution: ${event.callId}`)
  let next = entry
  if (event.type === "CodeCalled") {
    if (entry.ambient !== null) throw new RuntimeError("Code ambient is already recorded")
    next = { ...entry, ambient: event.ambient }
  } else if (event.type === "CodeReturned") {
    if (event.outcome.status === "fulfilled" && entry.calls.some(call => call.outcome === null)) throw new RuntimeError("Cannot return code with unsettled package calls")
    next = { ...entry, outcome: event.outcome, calls: event.outcome.status === "rejected" ? entry.calls.filter(call => call.ref !== null) : entry.calls }
  } else if (event.type === "MethodRequested") {
    if (!entry.ambient || entry.calls.some(call => call.ordinal === event.ordinal)) throw new RuntimeError("Invalid package invocation")
    if (position === undefined) throw new RuntimeError("Package request requires a journal position")
    const { ordinal, package: packageName, method, input } = event
    next = { ...entry, calls: [...entry.calls, { origin: position, ordinal, package: packageName, method, input, ref: null, outcome: null }].sort((a, b) => a.ordinal - b.ordinal) }
  } else {
    const call = entry.calls.find(call => call.ordinal === event.ordinal)
    if (!call || call.outcome !== null || !call.ref || effectKey(call.ref) !== effectKey(event.ref)) throw new RuntimeError("Package reference differs from acceptance")
    next = { ...entry, calls: entry.calls.map(value => value === call ? { ...call, outcome: event.outcome } : value) }
  }
  return state.flatMap(value => value !== entry ? [value] : next.returned && next.calls.every(call => call.outcome !== null) ? [] : [next])
}

export const executions = durableAtom({ name: "agent.code-mode.executions", input: Schema.Union([ModelReturned, ToolCalled, ToolReturned, DomainEvent, EffectAcceptance]), schema: CodeModeState, initial: [], reduce: codeModeState })
