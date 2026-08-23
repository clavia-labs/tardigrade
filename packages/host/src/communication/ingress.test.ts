import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Delivery } from "@clavia/tardigrade-core/communication/delivery"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { ActorUnavailable, ingressFrom, type IngressActor } from "./ingress"

const message = (id: string): MessageReceived => ({
  type: "MessageReceived",
  id,
  text: id,
  at: 42
})

const delivery = (actor: string, thread: string, id: string): Delivery => ({
  link: {
    source: { provider: "example" },
    target: { actor, thread }
  },
  event: message(id)
})

describe("ingressFrom", () => {
  test("commits a batch through its addressed actors in delivery order", async () => {
    const committed: string[] = []
    const target = (actor: string): IngressActor => ({
      commit: (delivery) =>
        Effect.sync(() =>
          committed.push(`${actor}:${delivery.link.target.thread}:${delivery.event.id}:${String((delivery.link.source as { provider?: unknown }).provider)}`)
        ),
      schedule: Effect.void
    })
    const ingress = ingressFrom((actor) => target(actor))

    await Effect.runPromise(ingress.commit([
      delivery("support", "incident", "m1"),
      delivery("release", "deploy", "m2"),
      delivery("support", "incident", "m3")
    ]))

    expect(committed).toEqual([
      "support:incident:m1:example",
      "release:deploy:m2:example",
      "support:incident:m3:example"
    ])
  })

  test("an empty batch commits nothing", async () => {
    let resolutions = 0
    const ingress = ingressFrom(() => {
      resolutions += 1
      return undefined
    })

    await Effect.runPromise(ingress.commit([]))

    expect(resolutions).toBe(0)
  })

  test("an unavailable actor refuses the complete batch before any commit", async () => {
    const committed: string[] = []
    const ingress = ingressFrom((actor) =>
      actor === "support"
        ? { commit: (delivery) => Effect.sync(() => committed.push(delivery.event.id)), schedule: Effect.void }
        : undefined
    )
    const error = await Effect.runPromise(
      ingress.commit([
        delivery("support", "incident", "m1"),
        delivery("missing", "incident", "m2")
      ]).pipe(Effect.flip)
    )

    expect(error).toEqual(new ActorUnavailable({ actor: "missing" }))
    expect(committed).toEqual([])
  })

  test("schedules each addressed actor once in first delivery order", async () => {
    const scheduled: string[] = []
    const ingress = ingressFrom((actor) => ({
      commit: () => Effect.void,
      schedule: Effect.sync(() => scheduled.push(actor))
    }))

    await Effect.runPromise(ingress.schedule([
      delivery("support", "incident", "m1"),
      delivery("release", "deploy", "m2"),
      delivery("support", "follow-up", "m3")
    ]))

    expect(scheduled).toEqual(["support", "release"])
  })
})
