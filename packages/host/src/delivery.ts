import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { AppendResult } from "@clavia/tardigrade-core/log"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { receivedEventOf } from "@clavia/tardigrade-core/interaction"
import { threadCreated, threadCreatedForDelivery, type ThreadLineage } from "@clavia/tardigrade-core/interaction/relations"
import { formatThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { requireDeliveryKey } from "./event-key"

export interface Delivery {
  readonly target: ThreadAddress
  readonly event: Event
  readonly lineage?: ThreadLineage | undefined
  readonly link?: Link<unknown, ThreadAddress> | undefined
  readonly call?: unknown
  readonly allocated?: boolean
  readonly keyOf?: ((event: Event) => string | undefined) | undefined
}

export interface DeliveryStore {
  readonly read: Effect.Effect<ReadonlyArray<Event>>
  readonly head: Effect.Effect<number>
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<AppendResult>
  readonly reserveRoot: Effect.Effect<void>
}

// commitDelivery validates lineage and commits thread creation with its first delivery (allocation.test.ts; platform/bun/src/host.test.ts; platform/cloudflare/test/actor.workers.ts).
export const commitDelivery = (delivery: Delivery, store: DeliveryStore) => Effect.gen(function* () {
  const { target, event, lineage, link, call, allocated = false } = delivery
  const address = formatThreadAddress(target)
  if (lineage !== undefined && (lineage.parent.actor !== target.actor || lineage.parent.instance !== target.instance)) {
    return yield* Effect.die(new Error("a child thread must inherit its actor instance"))
  }
  if (!allocated) requireDeliveryKey(event, address, delivery.keyOf)
  const current = yield* store.read
  const created = threadCreatedForDelivery(current, target, lineage, link?.source)
  if (allocated && created?.parent !== undefined) return yield* Effect.die(new Error("a child thread cannot be recreated as a root"))
  const landed = receivedEventOf({ target, event, ...(link === undefined ? {} : { link }), ...(call === undefined ? {} : { call }) })
  if (created === undefined && lineage === undefined && !allocated) yield* store.reserveRoot
  if (landed.type === "MessageReceived" && current.some((candidate) => candidate.type === "MessageReceived" && String(candidate.id) === String(landed.id))) {
    return { appended: 0, head: yield* store.head, landed, opened: false }
  }
  const at = event.at
  if (created === undefined && (typeof at !== "number" || !Number.isFinite(at))) return yield* Effect.die(new Error(`first thread event "${event.type}" must carry a finite at`))
  const batch = allocated ? (created === undefined ? [landed] : []) : created === undefined ? [threadCreated(target, lineage, at as number), landed] : [landed]
  const result = yield* store.append(batch)
  return { ...result, landed, opened: created === undefined }
})

// commitTracedDelivery carries the producer span into persisted events (platform/bun/src/host.test.ts).
export const commitTracedDelivery = (delivery: Delivery, store: DeliveryStore) => Effect.gen(function* () {
  const span = yield* Effect.currentSpan.pipe(Effect.option)
  const event = span._tag === "Some" && delivery.event.traceparent === undefined
    ? { ...delivery.event, traceparent: traceparentOf(span.value) } : delivery.event
  return yield* commitDelivery({ ...delivery, event }, store)
}).pipe(Effect.withSpan("commit", { kind: "producer", attributes: { to: formatThreadAddress(delivery.target), type: delivery.event.type } }))
