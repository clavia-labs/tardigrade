import { Schema } from "effect"
import type { Event } from "./event"
import type { KeyFragment } from "./event-log"
import { ActorId, type ActorId as ActorIdType } from "./communication/endpoint"

export const ThreadDepth = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

export type ThreadDepth = typeof ThreadDepth.Type

// ThreadLineage is the creation claim carried by an initial child delivery. The parent is an address rather than a placement or lane grammar.
export interface ThreadLineage {
  readonly parent: ActorIdType
  readonly depth: number
}

// ThreadCreated is the first event in one actor thread's log. Its address and lineage remain fixed for that log (tla/runtime/Thread.tla, CreationFirst and AcceptedMatchesCreated).
export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("ThreadCreated"),
  address: ActorId,
  parent: Schema.optional(ActorId),
  depth: ThreadDepth,
  at: Schema.Finite
})

export type ThreadCreated = typeof ThreadCreated.Type

// isThreadCreated reports whether an open event carries a valid durable thread identity.
export const isThreadCreated = (event: Event | undefined): event is ThreadCreated => {
  if (event?.type !== "ThreadCreated") return false
  const value = event as { readonly address?: unknown; readonly parent?: unknown; readonly depth?: unknown; readonly at?: unknown }
  return Schema.is(ActorId)(value.address) &&
    (value.parent === undefined || Schema.is(ActorId)(value.parent)) &&
    typeof value.depth === "number" && Number.isSafeInteger(value.depth) && value.depth >= 0 &&
    typeof value.at === "number" && Number.isFinite(value.at)
}

// threadCreatedOf reads the identity record only from the first log position.
export const threadCreatedOf = (events: ReadonlyArray<Event>): ThreadCreated | undefined =>
  isThreadCreated(events[0]) ? events[0] : undefined

// childLineageOf derives a child's claim from its parent's durable identity.
export const childLineageOf = (parent: ThreadCreated): ThreadLineage => ({
  parent: parent.address,
  depth: parent.depth + 1
})

// threadCreated constructs the target's immutable creation record.
export const threadCreated = (
  address: ActorIdType,
  lineage: ThreadLineage | undefined,
  at: number
): ThreadCreated => ({
  type: "ThreadCreated",
  address,
  ...(lineage === undefined ? {} : { parent: lineage.parent }),
  depth: lineage?.depth ?? 0,
  at
})

// sameActorId compares actor identity without serializing it.
export const sameActorId = (left: ActorIdType, right: ActorIdType): boolean =>
  left.actor === right.actor && left.thread === right.thread

// sameThreadLineage reports whether a creation claim matches a stored identity.
export const sameThreadLineage = (created: ThreadCreated, lineage: ThreadLineage): boolean =>
  created.parent !== undefined && sameActorId(created.parent, lineage.parent) && created.depth === lineage.depth

// threadKeys gives each log one durable creation occurrence.
export const threadKeys: KeyFragment = {
  prefixes: ["thread:"],
  keyOf: (event) => event.type === "ThreadCreated" ? "thread:created" : undefined
}
