import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { commitDelivery } from "./delivery"

test("delivery requires creation and preserves the log across redelivery", async () => {
  const target = { actor: "test", instance: "main", thread: "root" }
  const events: Event[] = []
  const delivery = { target, event: { type: "MessageReceived", id: "first", at: 1 } }
  const store = {
    read: Effect.sync(() => [...events]),
    head: Effect.sync(() => events.length),
    append: (batch: ReadonlyArray<Event>) => Effect.sync(() => {
      events.push(...batch)
      return { appended: batch.length, head: events.length }
    })
  }
  await expect(Effect.runPromise(commitDelivery(delivery, store))).rejects.toThrow("delivery requires a created thread")
  expect(events).toEqual([])
  const created = threadCreated(target, undefined, 0)
  events.push(created)
  await Effect.runPromise(commitDelivery(delivery, store))
  await Effect.runPromise(commitDelivery(delivery, store))
  expect(events).toEqual([created, expect.objectContaining(delivery.event)])
})
