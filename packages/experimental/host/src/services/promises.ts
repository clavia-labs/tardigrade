import { Context, Effect } from "effect"
import type { ExecutionHandle } from "@clavia/tardigrade-experimental-core"
import type { ResolutionRequest, ResolutionRegistration, ResolutionState } from "../contracts"

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
