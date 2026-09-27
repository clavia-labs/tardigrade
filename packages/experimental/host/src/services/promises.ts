import { Context, Effect, Schema } from "effect"
import { EffectRef, ExecutionHandle, ThreadCoordinate } from "@clavia/tardigrade-experimental-core"

export const ResolutionRequest = Schema.Struct({ ref: EffectRef, handle: ExecutionHandle, mode: Schema.optionalKey(Schema.Literals(["poll", "push"])) })
export type ResolutionRequest = typeof ResolutionRequest.Type
export const ResolutionRegistration = Schema.Struct({ ...ResolutionRequest.fields, recipient: ThreadCoordinate })
export type ResolutionRegistration = typeof ResolutionRegistration.Type
export const ResolutionResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.Json }),
  Schema.Struct({ status: Schema.Literal("rejected"), error: Schema.String }),
])
export const Resolution = Schema.Struct({ type: Schema.Literal("PromiseSettled"), ref: EffectRef, result: ResolutionResult })
export type Resolution = typeof Resolution.Type
export type ResolutionResult = Resolution["result"]
export type ResolutionState = { readonly status: "pending" } | ResolutionResult
export type ResolutionPoll = (handle: ExecutionHandle) => Effect.Effect<ResolutionState, Error>

// Promises registers a promise for eventual settlement; duplicate references must retain the same execution handle.
export class Promises extends Context.Service<Promises, {
  readonly watch: (request: ResolutionRequest) => Effect.Effect<void, Error>
  // cancel stops observation and future delivery attempts; backend cancellation is separate.
  readonly cancel: (request: ResolutionRequest) => Effect.Effect<void, Error>
}>()("experimental/host/Promises") {}

export const DEFAULT_PROMISE_POLICY = { pollIntervalMs: 1_000, retryIntervalMs: 5_000, attemptTimeoutMs: 30_000, retentionMs: 86_400_000 } as const
export interface PromisePolicy { readonly pollIntervalMs: number; readonly retryIntervalMs: number; readonly attemptTimeoutMs: number; readonly retentionMs: number }

// promisePolicy validates scheduling and attempt bounds supplied by the host.
export function promisePolicy(overrides: Partial<PromisePolicy> = {}): PromisePolicy {
  const policy = { ...DEFAULT_PROMISE_POLICY, ...overrides }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`)
  }
  return policy
}

export const resolutionKey = (request: ResolutionRequest) => JSON.stringify([request.ref.atom, request.ref.seq, request.ref.tag])
export const registrationKey = (request: ResolutionRegistration) => JSON.stringify([request.recipient.actor, request.recipient.instance, request.recipient.thread, resolutionKey(request)])
