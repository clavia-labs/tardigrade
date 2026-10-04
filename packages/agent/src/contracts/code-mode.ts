import { Schema } from "effect"
import { act, Deadline, EffectRef } from "@clavia/tardigrade-core"
import { Event as AgentEvent } from "./events"

const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.Json }),
  Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.String }),
])
const Ambient = Schema.Struct({ at: Deadline, seed: Schema.String })
const Ordinal = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Invocation = Schema.Struct({ ordinal: Ordinal, package: Schema.NonEmptyString, method: Schema.NonEmptyString, input: Schema.Json })
export const CodeModeName = Schema.NonEmptyString
const Owner = { codeMode: Schema.NonEmptyString, callId: Schema.NonEmptyString }
export const CodeCalled = Schema.Struct({ type: Schema.Literal("CodeCalled"), ...Owner, ambient: Ambient })
export const CodeReturned = Schema.Struct({ type: Schema.Literal("CodeReturned"), ...Owner, outcome: Outcome })
export const MethodRequested = Schema.Struct({ type: Schema.Literal("MethodRequested"), ...Owner, ...Invocation.fields })
export const MethodReturned = Schema.Struct({ type: Schema.Literal("MethodReturned"), ...Owner, ordinal: Ordinal, ref: EffectRef, outcome: Outcome })
export const DomainEvent = Schema.Union([CodeCalled, CodeReturned, MethodRequested, MethodReturned])
export const Event = Schema.Union([AgentEvent, DomainEvent])

export const EvaluationInput = Schema.Struct({ ...Owner, code: Schema.String, libraries: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)) })
export const PackageInput = Schema.Struct({ ...Owner, ...Invocation.fields })
export const EvaluateCode = act({ name: "code-mode.evaluate", input: EvaluationInput, success: Schema.Json, failure: Schema.String })
export const ExecutePackage = act({ name: "code-mode.package", input: PackageInput, success: Schema.Json, failure: Schema.String })
