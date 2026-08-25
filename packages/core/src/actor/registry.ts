import type { Effect } from "effect"

// ActorRegistration names an actor record independently of the store that holds it.
export interface ActorRegistration {
  readonly name: string
}

// ActorRegistry resolves and mutates actor records through Effects supplied by a platform. list orders records by name, put replaces the record under the same name, and remove absorbs an absent name (platform/bun/src/registry.test.ts; platform/cloudflare/test/actor.workers.ts).
export interface ActorRegistry<Registration extends ActorRegistration, Error = never> {
  readonly resolve: (name: string) => Effect.Effect<Registration | undefined, Error>
  readonly list: Effect.Effect<ReadonlyArray<Registration>, Error>
  readonly put: (registration: Registration) => Effect.Effect<void, Error>
  readonly remove: (name: string) => Effect.Effect<void, Error>
}
