import { durableAtom, effectKey, RuntimeError, EffectRequested } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { ModelReturned, ToolReturned } from "../event"
import { DomainEvent, EvaluateCode, EvaluationInput, ExecutePackage, PackageInput, CodeModeState, type Event } from "./contracts"

// codeModeState retains code inputs and package receipts until their tool results are delivered.
export function codeModeState(state: typeof CodeModeState.Type, event: typeof Event.Type | EffectRequested): typeof CodeModeState.Type {
  if (event.type === "ModelReturned" && event.purpose === "inference") return [...state, ...event.toolCalls.map(call => ({ call, codeMode: null, evaluation: null, ambient: null, returned: false, calls: [], outcome: null }))]
  if (event.type === "ToolReturned") return state.flatMap(entry => entry.call.callId !== event.callId ? [entry]
    : entry.calls.every(call => call.outcome !== null) ? [] : [{ ...entry, returned: true }])
  if (event.type === "EffectRequested") {
    if (event.request.executor === EvaluateCode.name) {
      const input = Schema.decodeUnknownSync(EvaluationInput)(event.request.input)
      const entry = state.find(entry => entry.call.callId === input.callId)
      if (!entry || entry.outcome !== null || entry.evaluation !== null) throw new RuntimeError(`No pending code evaluation: ${input.callId}`)
      return state.map(value => value === entry ? { ...entry, codeMode: input.codeMode, evaluation: event.ref } : value)
    }
    if (event.request.executor !== ExecutePackage.name) return state
    const input = Schema.decodeUnknownSync(PackageInput)(event.request.input)
    const entry = state.find(entry => entry.codeMode === input.codeMode && entry.call.callId === input.callId)
    const call = entry?.calls.find(call => call.ordinal === input.ordinal)
    if (!entry || !call || call.ref !== null || call.outcome !== null) throw new RuntimeError("No pending package acceptance")
    return state.map(value => value === entry ? { ...entry, calls: entry.calls.map(value => value === call ? { ...call, ref: event.ref } : value) } : value)
  }
  if (!("codeMode" in event)) return state
  const entry = state.find(entry => entry.call.callId === event.callId && entry.codeMode === event.codeMode)
  if (!entry || (entry.outcome !== null && event.type !== "PackageReturned")) throw new RuntimeError(`No pending code execution: ${event.callId}`)
  let next = entry
  if (event.type === "CodeCalled") {
    if (entry.ambient !== null) throw new RuntimeError("Code ambient is already recorded")
    next = { ...entry, ambient: event.ambient }
  } else if (event.type === "CodeReturned") {
    if (event.outcome.status === "fulfilled" && entry.calls.some(call => call.outcome === null)) throw new RuntimeError("Cannot return code with unsettled package calls")
    next = { ...entry, outcome: event.outcome, calls: event.outcome.status === "rejected" ? entry.calls.filter(call => call.ref !== null) : entry.calls }
  } else if (event.type === "PackageCalled") {
    if (!entry.ambient || entry.calls.some(call => call.ordinal === event.ordinal)) throw new RuntimeError("Invalid package invocation")
    const { ordinal, package: packageName, method, input } = event
    next = { ...entry, calls: [...entry.calls, { ordinal, package: packageName, method, input, ref: null, outcome: null }].sort((a, b) => a.ordinal - b.ordinal) }
  } else {
    const call = entry.calls.find(call => call.ordinal === event.ordinal)
    if (!call || call.outcome !== null || !call.ref || effectKey(call.ref) !== effectKey(event.ref)) throw new RuntimeError("Package reference differs from acceptance")
    next = { ...entry, calls: entry.calls.map(value => value === call ? { ...call, outcome: event.outcome } : value) }
  }
  return state.flatMap(value => value !== entry ? [value] : next.returned && next.calls.every(call => call.outcome !== null) ? [] : [next])
}

export const executions = durableAtom({ name: "agent.code-mode.executions", input: Schema.Union([ModelReturned, ToolReturned, DomainEvent, EffectRequested]), schema: CodeModeState, initial: [], reduce: codeModeState })
