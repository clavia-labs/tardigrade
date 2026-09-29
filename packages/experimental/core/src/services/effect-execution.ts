import { Context, Effect } from "effect"
import type { Getter } from "../atom"
import type { FiberHandle } from "../effects"
import type { EffectRef } from "../effect-ref"

// EffectExecution supplies the current effect identity and forks work within the actor's lifetime.
export class EffectExecution extends Context.Service<EffectExecution, {
  readonly ref: EffectRef
  readonly get: Getter
  readonly record: <Event extends object>(event: Event) => Effect.Effect<void, Error>
  readonly fork: <Event extends object, Services>(work: Effect.Effect<Event | readonly Event[], Error, Services>) => Effect.Effect<FiberHandle, Error, Services>
}>()("experimental/EffectExecution") {}
