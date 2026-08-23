import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "../event"
import { isActorAddress, isProviderAddress, type ActorAddress, type ProviderAddress } from "./address"
import { deliveryOf } from "./delivery"
import { linkOf } from "./link"
import { deliverThrough, transportRoute } from "./router"
import type { Transport } from "./transport"

const source: ActorAddress = { actor: "agent", thread: "root" }
const localTarget: ActorAddress = { actor: "agent", thread: "child" }
const providerTarget: ProviderAddress = { provider: "slack", channel: "C1" }
const message = { type: "MessageReceived", id: "m1", text: "hello", at: 1 } as Event

describe("transport routing", () => {
  test("the router resolves coordinates and selects one transport", async () => {
    const carried: Array<{ name: string; coordinates: unknown }> = []
    const local: Transport<ActorAddress> = {
      name: "local",
      deliver: (coordinates) => Effect.sync(() => carried.push({ name: "local", coordinates }))
    }
    const provider: Transport<ProviderAddress> = {
      name: "provider",
      deliver: (coordinates) => Effect.sync(() => carried.push({ name: "provider", coordinates }))
    }
    const routes = [
      transportRoute(local, (delivery) => isActorAddress(delivery.link.target) ? delivery.link.target : undefined),
      transportRoute(provider, (delivery) => isProviderAddress(delivery.link.target) ? delivery.link.target : undefined)
    ]
    await Effect.runPromise(deliverThrough(routes, deliveryOf(linkOf(source, localTarget), message)))
    await Effect.runPromise(deliverThrough(routes, deliveryOf(linkOf(source, providerTarget), message)))
    expect(carried).toEqual([
      { name: "local", coordinates: localTarget },
      { name: "provider", coordinates: providerTarget }
    ])
  })

  test("a missing route refuses the delivery", async () => {
    await expect(Effect.runPromise(deliverThrough([], deliveryOf(linkOf(source, localTarget), message)))).rejects.toThrow(
      "no transport accepts target"
    )
  })

  test("overlapping routes refuse before either transport sends", async () => {
    let sent = 0
    const transport = (name: string): Transport<ActorAddress> => ({
      name,
      deliver: () => {
        sent += 1
        return Effect.void
      }
    })
    const coordinatesFor = () => localTarget
    const delivery = deliveryOf(linkOf(source, localTarget), message)
    await expect(Effect.runPromise(deliverThrough([
      transportRoute(transport("local"), coordinatesFor),
      transportRoute(transport("durable-object"), coordinatesFor)
    ], delivery))).rejects.toThrow("multiple transports accept target")
    expect(sent).toBe(0)
  })
})
