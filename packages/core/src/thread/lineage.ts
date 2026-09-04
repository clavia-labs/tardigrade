import { Schema } from "effect"
import { formatThreadAddress, isThreadAddress, ThreadAddress, type ThreadAddress as ThreadAddressType } from "../communication/endpoint"
import type { Event } from "@clavia/tardigrade-core/event"
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

// ChildCreated records a child edge in its parent log before the first delivery crosses the host boundary. `turn` names the parent run that minted the call, so the edge and its dedup key are scoped to that run (packages/agent/src/index.test.ts, "one complete RLM run records root and child lineage and settles with their answers"). A record from before the field existed has no turn and keeps its call-scoped key.
export const ChildCreated = Schema.Struct({
  type: Schema.Literal("ChildCreated"),
  callId: Schema.String,
  turn: Schema.optional(Schema.String),
  address: ThreadAddress,
  depth: ThreadDepth,
  placement: Schema.optional(ChildPlacement),
  at: Schema.Finite
})

export type ChildCreated = typeof ChildCreated.Type

export const childCreated = (
  callId: string,
  address: ThreadAddressType,
  lineage: ThreadLineage,
  at: number,
  turn?: string
): ChildCreated => ({
  type: "ChildCreated",
  callId,
  ...(turn === undefined ? {} : { turn }),
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

// threadCreatedForDelivery validates a target's stored identity and an incoming creation claim before a host appends the delivery.
export const threadCreatedForDelivery = (
  events: ReadonlyArray<Event>,
  target: ThreadAddressType,
  lineage: ThreadLineage | undefined,
  source?: unknown
): ThreadCreated | undefined => {
  const address = formatThreadAddress(target)
  const created = threadCreatedOf(events)
  if (events.length > 0 && created === undefined) throw new Error(`thread ${address} has no ThreadCreated first event`)
  if (created !== undefined && !sameThreadAddress(created.address, target)) {
    throw new Error(`thread ${address} creation address does not match its target`)
  }
  if (lineage !== undefined) {
    if (lineage.depth <= 0 || sameThreadAddress(lineage.parent, target)) {
      throw new Error(`thread ${address} has invalid child lineage`)
    }
    if (!isThreadAddress(source) || !sameThreadAddress(lineage.parent, source)) {
      throw new Error(`thread ${address} lineage parent does not match its delivery source`)
    }
    if (created !== undefined && !sameThreadLineage(created, lineage)) {
      throw new Error(`thread ${address} already has different lineage`)
    }
  } else if (created === undefined && isThreadAddress(source)) {
    throw new Error(`initial actor delivery to ${address} must carry lineage`)
  }
  return created
}

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
  left.actor === right.actor && left.instance === right.instance && left.thread === right.thread

// sameThreadLineage reports whether a creation claim matches a stored identity.
export const sameThreadLineage = (created: ThreadCreated, lineage: ThreadLineage): boolean =>
  created.parent !== undefined && sameThreadAddress(created.parent, lineage.parent) && created.depth === lineage.depth &&
  (created.placement === undefined || lineage.placement === undefined || created.placement === lineage.placement)

// threadKeys gives each log one durable creation occurrence, scoped to the run that minted the
// call. JSON.stringify keeps the pair injective where plain concatenation could collide.
export const threadKeys: KeyFragment = {
  prefixes: ["thread:"],
  keyOf: (event) => {
    if (event.type === "ThreadCreated") return "thread:created"
    if (event.type !== "ChildCreated") return undefined
    const callId = typeof event.callId === "string" ? event.callId : undefined
    if (callId === undefined) return undefined
    return typeof event.turn === "string"
      ? `thread:child:${JSON.stringify([event.turn, callId])}`
      : `thread:child:${callId}`
  }
}
