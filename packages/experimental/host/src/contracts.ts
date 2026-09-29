import { Schema } from "effect"
import { EffectRef, ExecutionHandle, promiseSchema } from "@clavia/tardigrade-experimental-core"

export const ThreadCoordinate = Schema.Struct({ actor: Schema.NonEmptyString, instance: Schema.NonEmptyString, thread: Schema.NonEmptyString })
export type ThreadCoordinate = typeof ThreadCoordinate.Type
export const ActorDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), amount: Schema.optionalKey(Schema.Finite) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])
export type ActorDecision = typeof ActorDecision.Type
export const ActorRequest = Schema.Struct({ requestId: Schema.NonEmptyString, kind: Schema.Literals(["permission", "budget"]), description: Schema.String, input: Schema.Json })
export type ActorRequest = typeof ActorRequest.Type
export const ActorCall = Schema.Struct({ id: Schema.NonEmptyString, message: Schema.String, config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) })
export type ActorCall = typeof ActorCall.Type

export const ResolutionRequest = Schema.Struct({ ref: EffectRef, handle: ExecutionHandle, mode: Schema.optionalKey(Schema.Literals(["poll", "push"])) })
export type ResolutionRequest = typeof ResolutionRequest.Type
export const ResolutionRegistration = Schema.Struct({ ...ResolutionRequest.fields, recipient: ThreadCoordinate })
export type ResolutionRegistration = typeof ResolutionRegistration.Type

const Settlement = promiseSchema({ success: Schema.Json, error: Schema.String })

// PromiseSettled specializes core promise settlements to the host's string failures.
export const PromiseSettled = Schema.toType(Settlement)
export type PromiseSettled = typeof PromiseSettled.Type
export const ResolutionResult = Schema.toType(Settlement.fields.result)
export type ResolutionResult = typeof ResolutionResult.Type
export type ResolutionState = { readonly status: "pending" } | ResolutionResult
