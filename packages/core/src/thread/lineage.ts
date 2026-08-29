import { Schema } from "effect"
import { ThreadAddress, type ThreadAddress as ThreadAddressType } from "../communication/endpoint"
import type { Event } from "../log/event"
import type { KeyFragment } from "../log/keys"

export const ThreadDepth = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

export type ThreadDepth = typeof ThreadDepth.Type

export const ChildPlacement = Schema.Literals(["colocated", "independent"])
export type ChildPlacement = typeof ChildPlacement.Type

// ThreadLineage is the creation claim carried by an initial child delivery. Placement is relative to the parent host.
export interface ThreadLineage {
  readonly parent: ThreadAddressType
  readonly depth: number
  readonly placement?: ChildPlacement
}

// ThreadCreated is the first event in one actor thread's log. Its address and lineage remain fixed for that log (tla/runtime/Thread.tla, CreationFirst and AcceptedMatchesCreated).
export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("ThreadCreated"),
  address: ThreadAddress,
  parent: Schema.optional(ThreadAddress),
  depth: ThreadDepth,
  placement: Schema.optional(ChildPlacement),
  at: Schema.Finite
})

export type ThreadCreated = typeof ThreadCreated.Type

// ChildCreated records a child edge in its parent log before the first delivery crosses the host boundary (packages/agent/src/index.test.ts, "one complete RLM run records root and child lineage and settles with their answers").
export const ChildCreated = Schema.Struct({
  type: Schema.Literal("ChildCreated"),
  callId: Schema.String,
  address: ThreadAddress,
  depth: ThreadDepth,
  placement: Schema.optional(ChildPlacement),
  at: Schema.Finite
})

export type ChildCreated = typeof ChildCreated.Type

export const childCreated = (callId: string, address: ThreadAddressType, lineage: ThreadLineage, at: number): ChildCreated => ({
  type: "ChildCreated",
  callId,
  address,
  depth: lineage.depth,
  ...(lineage.placement === undefined ? {} : { placement: lineage.placement }),
  at
})

// isThreadCreated reports whether an open event carries a valid durable thread identity.
export const isThreadCreated = (event: Event | undefined): event is ThreadCreated => {
  if (event?.type !== "ThreadCreated") return false
  const value = event as { readonly address?: unknown; readonly parent?: unknown; readonly depth?: unknown; readonly placement?: unknown; readonly at?: unknown }
  return Schema.is(ThreadAddress)(value.address) &&
    (value.parent === undefined || Schema.is(ThreadAddress)(value.parent)) &&
    typeof value.depth === "number" && Number.isSafeInteger(value.depth) && value.depth >= 0 &&
    (value.placement === undefined || Schema.is(ChildPlacement)(value.placement)) &&
    typeof value.at === "number" && Number.isFinite(value.at)
}

// threadCreatedOf reads the identity record only from the first log position.
export const threadCreatedOf = (events: ReadonlyArray<Event>): ThreadCreated | undefined =>
  isThreadCreated(events[0]) ? events[0] : undefined

// childLineageOf derives a child's claim from its parent's durable identity.
export const childLineageOf = (parent: ThreadCreated, placement?: ChildPlacement): ThreadLineage => ({
  parent: parent.address,
  depth: parent.depth + 1,
  ...(placement === undefined ? {} : { placement })
})

// threadCreated constructs the target's immutable creation record.
export const threadCreated = (
  address: ThreadAddressType,
  lineage: ThreadLineage | undefined,
  at: number
): ThreadCreated => ({
  type: "ThreadCreated",
  address,
  ...(lineage === undefined ? {} : { parent: lineage.parent }),
  depth: lineage?.depth ?? 0,
  ...(lineage?.placement === undefined ? {} : { placement: lineage.placement }),
  at
})

// sameThreadAddress compares thread addresses without serializing them.
export const sameThreadAddress = (left: ThreadAddressType, right: ThreadAddressType): boolean =>
  left.actor === right.actor && left.thread === right.thread

// sameThreadLineage reports whether a creation claim matches a stored identity.
export const sameThreadLineage = (created: ThreadCreated, lineage: ThreadLineage): boolean =>
  created.parent !== undefined && sameThreadAddress(created.parent, lineage.parent) && created.depth === lineage.depth &&
  (created.placement === undefined || lineage.placement === undefined || created.placement === lineage.placement)

// threadKeys gives each log one durable creation occurrence.
export const threadKeys: KeyFragment = {
  prefixes: ["thread:"],
  keyOf: (event) => {
    if (event.type === "ThreadCreated") return "thread:created"
    if (event.type !== "ChildCreated") return undefined
    const callId = (event as { readonly callId?: unknown }).callId
    return typeof callId === "string" ? `thread:child:${callId}` : undefined
  }
}
