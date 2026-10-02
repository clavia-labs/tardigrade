import { Context, Effect, type Schema } from "effect"
import type { Getter, Atom } from "../atoms/atom"
import type { FiberHandle, ExecutionHandle, EffectRef } from "../runtime/effects"

// EffectExecution supplies the current reference, cancellation signal, and execution capabilities.
export class EffectExecution extends Context.Service<EffectExecution, {
  readonly ref: EffectRef
  readonly signal: AbortSignal
  readonly cancel: (ref: EffectRef, reason: Schema.Json) => Effect.Effect<void, Error>
  // submit retains an accepted handle before interruption can discard it (quint/cancellation.qnt, submit).
  readonly submit: <Services>(work: Effect.Effect<ExecutionHandle, Error, Services>) => Effect.Effect<ExecutionHandle, Error, Services>
  readonly get: Getter
  readonly waitFor: <Value>(node: Atom<Value | undefined>) => Effect.Effect<Value, Error>
  readonly record: <Event extends object>(event: Event) => Effect.Effect<void, Error>
  readonly fork: <Event extends object, Services>(work: Effect.Effect<Event | readonly Event[], Error, Services>) => Effect.Effect<FiberHandle, Error, Services>
}>()("experimental/EffectExecution") {}
