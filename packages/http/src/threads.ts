import { Context, Data, Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor"
import type { ThreadEventRow } from "@clavia/tardigrade-core/log"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import type { ActorSummary, ActorArtifact, ActorMetadata } from "@clavia/tardigrade-client/contract"

export class ActorPushRefused extends Data.TaggedError("ActorPushRefused")<{
  readonly message: string
  readonly cause: unknown
}> {}

import type { ThreadStatusOf } from "./projections"

export interface ActorThreads {
  readonly allocateRoot: (name?: string, options?: { readonly key?: string; readonly parent?: string }) => Effect.Effect<ThreadCoordinate>
  readonly methods: ActorMethods
  readonly storage: ActorMetadata["storage"]
  readonly statusOf: ThreadStatusOf
  readonly append: (id: string, event: Event) => Effect.Effect<void>
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly eventsPage: (id: string, mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (id: string, mark: number) => Effect.Effect<number>
  readonly actorEventsPage: (mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly actorThreads: Effect.Effect<{
    readonly cursor: number
    readonly threads: ReadonlyArray<ActorThreadRecord>
  }>
  readonly actorThread: (thread: string) => Effect.Effect<ActorThreadRecord | undefined>
  readonly awaitActorHead: (mark: number) => Effect.Effect<number>
  readonly list: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
  readonly settled: Effect.Effect<void>
}

// Threads exposes the mounted actor's method declarations beside its durable thread operations. Method meaning stays with the actor, while the service stores and returns its event log (packages/core/src/method/method.ts, ActorMethodDeclaration).
export class Threads extends Context.Service<
  Threads,
  {
    readonly methods: ActorThreads["methods"]
    readonly storage: ActorThreads["storage"]
    readonly actorName?: string
    // settled resolves once the drive in flight, and the follow-up it coalesced, has finished. A
    // client never waits on it (a delivery answers 202 and the client polls the turn); a test and
    // a shutdown do (host.test.ts).
    readonly instances: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly definition: string }>>
    readonly ensure: (id: string) => Effect.Effect<ActorThreads>
    readonly instance: (id: string) => Effect.Effect<ActorThreads | undefined>
    readonly append: (actor: string, thread: string, event: Event) => Effect.Effect<void>
    readonly events: (actor: string, thread: string) => Effect.Effect<ReadonlyArray<Event>>
    readonly list: (actor: string) => ActorThreads["list"]
    readonly settled: (actor: string) => Effect.Effect<void>
    readonly definitions?: Effect.Effect<ReadonlyArray<ActorSummary>>
    readonly definition?: (name: string) => Effect.Effect<ActorThreads | undefined>
    readonly pushDefinition?: (artifact: ActorArtifact) => Effect.Effect<ActorSummary, ActorPushRefused>
  }
>()("tardigrade/server/Threads") {}

