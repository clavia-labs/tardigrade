import { Context, Effect, Schema } from "effect"
import { Deadline, EffectRef, ExecutionHandle } from "../runtime/effects"
import { promiseSchema } from "../atoms/promise"
import { ThreadCoordinate } from "../actor/thread"

export const ResolutionRequest = Schema.Struct({ ref: EffectRef, handle: ExecutionHandle, deadlineAt: Schema.optionalKey(Deadline), mode: Schema.optionalKey(Schema.Literals(["poll", "push"])) })
export type ResolutionRequest = typeof ResolutionRequest.Type
export const ResolutionRegistration = Schema.Struct({ ...ResolutionRequest.fields, recipient: ThreadCoordinate })
export type ResolutionRegistration = typeof ResolutionRegistration.Type

const Settlement = promiseSchema({ success: Schema.Json, error: Schema.String })

// ResolutionSettled specializes core promise settlements to string failures.
export const ResolutionSettled = Schema.toType(Settlement)
export type ResolutionSettled = typeof ResolutionSettled.Type
export const ResolutionResult = Schema.toType(Settlement.fields.result)
export type ResolutionResult = typeof ResolutionResult.Type
export type ResolutionState = { readonly status: "pending" } | ResolutionResult

export type ResolutionPoll = (handle: ExecutionHandle) => Effect.Effect<ResolutionState, Error>

// Promises registers a promise for eventual settlement; duplicate references must retain the same execution handle.
export class Promises extends Context.Service<Promises, {
  readonly watch: (request: ResolutionRequest) => Effect.Effect<void, Error>
  // cancel stops observation and future delivery attempts; backend cancellation is separate.
  readonly cancel: (request: ResolutionRequest) => Effect.Effect<void, Error>
}>()("experimental/Promises") {}

export const DEFAULT_PROMISE_POLICY = { timeoutMs: 60_000, pollIntervalMs: 1_000, retryIntervalMs: 5_000, attemptTimeoutMs: 30_000, retentionMs: 86_400_000 } as const
export interface PromisePolicy { readonly timeoutMs: number; readonly pollIntervalMs: number; readonly retryIntervalMs: number; readonly attemptTimeoutMs: number; readonly retentionMs: number }

// promiseDeadline preserves recorded expiry; clock promises receive their waiting budget after the scheduled time.
export function promiseDeadline(handle: ExecutionHandle, startedAt: number, policy: PromisePolicy, recorded?: number): number {
  return Schema.decodeSync(Deadline)(recorded ?? Math.max(startedAt, handle.executor === "clock" ? handle.at ?? startedAt : startedAt) + policy.timeoutMs)
}

// promisePolicy validates scheduling and attempt bounds supplied by the host.
export function promisePolicy(overrides: Partial<PromisePolicy> = {}): PromisePolicy {
  const policy = { ...DEFAULT_PROMISE_POLICY, ...overrides }
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`)
  }
  return policy
}

export const resolutionKey = (request: ResolutionRequest) => JSON.stringify([request.ref.atom, request.ref.seq, request.ref.act])
export const registrationKey = (request: ResolutionRegistration) => JSON.stringify([request.recipient.actor, request.recipient.instance, request.recipient.thread, resolutionKey(request)])
