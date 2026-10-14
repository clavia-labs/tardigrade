import { Context, Effect, type Schema } from "effect"
import type { Getter, Atom } from "../atoms/atom"
import type { AttemptTimedOut, FiberHandle, ExecutionHandle, EffectRef } from "../runtime/effects"
import type { ExecutionUpdatePayload } from "./execution-stream"

export interface PromiseOptions { readonly timeoutMs?: number | undefined }
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000
export interface AttemptOptions {
  // attemptTimeoutMs requests interruption of each invocation; null disables the deadline.
  readonly attemptTimeoutMs?: number | null | undefined
}
export interface RetryDecision { readonly delayMs: number; readonly reason: Schema.Json }
export interface RetryOptions<Failure, Services = never> extends AttemptOptions {
  // attemptTimeoutMs requests interruption of each invocation; finalizers finish before decide (quint/attemptDeadline.qnt, interruptedBeforeDecisionTest).
  // Omission uses DEFAULT_ATTEMPT_TIMEOUT_MS; retry waits and decision callbacks are outside the deadline.
  readonly decide: (failure: Failure | AttemptTimedOut, attempt: number) => Effect.Effect<RetryDecision | undefined, Error, Services>
}

// EffectExecution supplies the current reference, cancellation signal, and execution capabilities.
export class EffectExecution extends Context.Service<EffectExecution, {
  readonly ref: EffectRef
  readonly signal: AbortSignal
  // retry owns the invocation's attempt sequence; a second retry boundary in the same execution rejects.
  readonly retry: <Value, Failure, Services, DecisionServices>(work: Effect.Effect<Value, Failure, Services>, options: RetryOptions<Failure, DecisionServices>) => Effect.Effect<Value, Failure | Error, Services | DecisionServices>
  readonly publish: (payload: ExecutionUpdatePayload) => Effect.Effect<void>
  readonly cancel: (ref: EffectRef, reason: Schema.Json) => Effect.Effect<void, Error>
  // submit retains an accepted handle before interruption can discard it (quint/cancellation.qnt, submit).
  readonly submit: <Services>(work: Effect.Effect<ExecutionHandle, Error, Services>, options?: PromiseOptions) => Effect.Effect<ExecutionHandle, Error, Services>
  readonly get: Getter
  readonly waitFor: <Value>(node: Atom<Value | undefined>) => Effect.Effect<Value, Error>
  readonly record: <Event extends object>(event: Event) => Effect.Effect<void, Error>
  readonly fork: <Event extends object, Services>(work: Effect.Effect<Event | readonly Event[], Error, Services>, options?: PromiseOptions) => Effect.Effect<FiberHandle, Error, Services>
}>()("experimental/EffectExecution") {}
