import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { AppendResult } from "@clavia/tardigrade-core/log"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { receivedEventOf } from "@clavia/tardigrade-core/interaction"
import { threadCreatedForDelivery, type ThreadLineage } from "@clavia/tardigrade-core/interaction/relations"
import { formatThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { requireDeliveryKey } from "./event-key"

export interface Delivery {
  readonly target: ThreadAddress
  readonly event: Event
  readonly lineage?: ThreadLineage | undefined
  readonly link?: Link<unknown, ThreadAddress> | undefined
  readonly call?: unknown
  readonly keyOf?: ((event: Event) => string | undefined) | undefined
}

export interface DeliveryStore {
  readonly read: Effect.Effect<ReadonlyArray<Event>>
  readonly head: Effect.Effect<number>
  readonly append: (events: ReadonlyArray<Event>) => Effect.Effect<AppendResult>
}

// validateDelivery rejects invalid ingress before allocation creates a log (host.test.ts).
export const validateDelivery = (delivery: Delivery, current: ReadonlyArray<Event>) => {
  const { target, event, lineage, link, call } = delivery
  if (lineage !== undefined && (lineage.parent.actor !== target.actor || lineage.parent.instance !== target.instance)) {
    throw new Error("a child thread must inherit its actor instance")
  }
  requireDeliveryKey(event, formatThreadAddress(target), delivery.keyOf)
  const landed = receivedEventOf({ target, event, ...(link === undefined ? {} : { link }), ...(call === undefined ? {} : { call }) })
  const created = threadCreatedForDelivery(current, target, lineage, link?.source)
  if (created === undefined && (typeof event.at !== "number" || !Number.isFinite(event.at))) {
    throw new Error(`first thread event "${event.type}" must carry a finite at`)
  }
  return { created, landed }
}

// commitDelivery appends validated messages to an existing thread without creating it (delivery.test.ts).
export const commitDelivery = (delivery: Delivery, store: DeliveryStore) => Effect.gen(function* () {
  const current = yield* store.read
  const { created, landed } = validateDelivery(delivery, current)
  if (created === undefined) return yield* Effect.die(new Error("delivery requires a created thread"))
  if (landed.type === "MessageReceived" && current.some((candidate) => candidate.type === "MessageReceived" && String(candidate.id) === String(landed.id))) {
    return { appended: 0, head: yield* store.head, landed }
  }
  const result = yield* store.append([landed])
  return { ...result, landed }
})

// commitTracedDelivery carries the producer span into persisted events (platform/bun/src/host.test.ts).
export const commitTracedDelivery = (delivery: Delivery, store: DeliveryStore) => Effect.gen(function* () {
  const span = yield* Effect.currentSpan.pipe(Effect.option)
  const event = span._tag === "Some" && delivery.event.traceparent === undefined
    ? { ...delivery.event, traceparent: traceparentOf(span.value) } : delivery.event
  return yield* commitDelivery({ ...delivery, event }, store)
}).pipe(Effect.withSpan("commit", { kind: "producer", attributes: { to: formatThreadAddress(delivery.target), type: delivery.event.type } }))
