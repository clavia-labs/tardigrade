import type { Effect, Schema } from "effect"
import type { Atom } from "./atom"
import type { Recorded, Proposed, ServicesOf } from "./internal/effects"
import type { EffectExecution } from "./effects"

export type Requirements<Atoms> = Exclude<ServicesOf<Proposed<Atoms[keyof Atoms] extends Atom<infer Value> ? Value : never>>, EffectExecution>

export interface ActorRuntime<Event extends object> {
  readonly ready: Effect.Effect<void>
  // onReady registers recovery during service construction, after replay and before the store opens.
  readonly onReady: (recover: Effect.Effect<void, Error>) => Effect.Effect<void>
  // onCommit registers host work acknowledged after each journal commit.
  readonly onCommit: (work: Effect.Effect<void, Error>) => Effect.Effect<void>
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
  readonly record: (event: Recorded<Event>) => Effect.Effect<void, Error>
  readonly send: (events: readonly Event[], when?: (get: ActorRuntime<Event>["get"]) => boolean) => Effect.Effect<void, Error>
  readonly fork: (id: string, work: Effect.Effect<void, Error>) => Effect.Effect<void, Error>
  readonly cancel: (id: string) => Effect.Effect<void, Error>
}

export interface ActorSetup<Event extends object, Atoms extends Readonly<Record<string, Atom<unknown>>>, Actions extends object> {
  readonly schema: Schema.Schema<Event>
  readonly effects: Atoms
  readonly actions: (emit: (event: Event) => Promise<void>) => Actions
  readonly validate?: (event: Event, get: ActorRuntime<Event>["get"]) => void
}
