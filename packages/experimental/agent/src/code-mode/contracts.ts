import { Schema } from "effect"
import { act, Deadline, EffectRef } from "@clavia/tardigrade-experimental-core"
import { Event as AgentEvent, ToolCall } from "../event"

const Outcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.Json }),
  Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.String }),
])
const Ambient = Schema.Struct({ at: Deadline, seed: Schema.String })
const Ordinal = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Invocation = Schema.Struct({ ordinal: Ordinal, package: Schema.NonEmptyString, method: Schema.NonEmptyString, input: Schema.Json })
const PackageRecord = Schema.Struct({ ...Invocation.fields, ref: Schema.NullOr(EffectRef), outcome: Schema.NullOr(Outcome) })
const Owner = { codeMode: Schema.NonEmptyString, callId: Schema.NonEmptyString }
export const CodeCalled = Schema.Struct({ type: Schema.Literal("CodeCalled"), ...Owner, ambient: Ambient })
export const CodeReturned = Schema.Struct({ type: Schema.Literal("CodeReturned"), ...Owner, outcome: Outcome })
export const PackageCalled = Schema.Struct({ type: Schema.Literal("PackageCalled"), ...Owner, ...Invocation.fields })
export const PackageReturned = Schema.Struct({ type: Schema.Literal("PackageReturned"), ...Owner, ordinal: Ordinal, ref: EffectRef, outcome: Outcome })
export const DomainEvent = Schema.Union([CodeCalled, CodeReturned, PackageCalled, PackageReturned])
export const Event = Schema.Union([AgentEvent, DomainEvent])
export const CodeModeState = Schema.Array(Schema.Struct({ call: ToolCall, codeMode: Schema.NullOr(Schema.String), evaluation: Schema.NullOr(EffectRef), ambient: Schema.NullOr(Ambient), returned: Schema.Boolean, calls: Schema.Array(PackageRecord), outcome: Schema.NullOr(Outcome) }))

export const EvaluationInput = Schema.Struct({ ...Owner, code: Schema.String })
export const PackageInput = Schema.Struct({ ...Owner, ...Invocation.fields })
export const EvaluateCode = act({ name: "code-mode.evaluate", input: EvaluationInput, success: Schema.Json, failure: Schema.String })
export const ExecutePackage = act({ name: "code-mode.package", input: PackageInput, success: Schema.Json, failure: Schema.String })
