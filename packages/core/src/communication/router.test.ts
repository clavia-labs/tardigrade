import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "../log/event"
import { mappedDirectory } from "./directory"
import type { ActorId, ProviderEndpoint } from "./endpoint"
import { envelopeOf, isActorEnvelope, isProviderEnvelope, type ActorEnvelope, type ProviderEnvelope } from "./envelope"
import { linkOf } from "./link"
import type { MessageReceived } from "./message"
import { directoryRoute, sendThrough } from "./router"
import type { Transport } from "./transport"

const source: ActorId = { actor: "agent", thread: "root" }
const localTarget: ActorId = { actor: "agent", thread: "child" }
const providerTarget: ProviderEndpoint = { provider: "slack", channel: "C1" }
const message = { type: "MessageReceived", id: "m1", text: "hello", at: 1 } as Event

interface LocalDestination {
  readonly node: string
  readonly actor: ActorId
}

describe("transport routing", () => {
  test("the router resolves a physical destination and preserves the logical envelope", async () => {
    const sent: Array<{ readonly name: string; readonly destination: unknown; readonly target: unknown }> = []
    const local: Transport<LocalDestination, ActorEnvelope> = {
      name: "local",
      send: (destination, envelope) => Effect.sync(() => sent.push({ name: "local", destination, target: envelope.link.target }))
    }
    const provider: Transport<ProviderEndpoint, ProviderEnvelope> = {
      name: "provider",
      send: (destination, envelope) => Effect.sync(() => sent.push({ name: "provider", destination, target: envelope.link.target }))
    }
    const routes = [
      directoryRoute(
        local,
        mappedDirectory((id: ActorId): LocalDestination => ({ node: "node-a", actor: id })),
        isActorEnvelope,
        (envelope) => envelope.link.target
      ),
      directoryRoute(
        provider,
        mappedDirectory((endpoint: ProviderEndpoint) => endpoint),
        isProviderEnvelope,
        (envelope) => envelope.link.target
      )
    ]
    await Effect.runPromise(sendThrough(routes, envelopeOf(linkOf(source, localTarget), message)))
    await Effect.runPromise(sendThrough(routes, envelopeOf(linkOf(source, providerTarget), message as MessageReceived)))
    expect(sent).toEqual([
      { name: "local", destination: { node: "node-a", actor: localTarget }, target: localTarget },
      { name: "provider", destination: providerTarget, target: providerTarget }
    ])
  })

  test("a missing route refuses the envelope", async () => {
    await expect(Effect.runPromise(sendThrough([], envelopeOf(linkOf(source, localTarget), message)))).rejects.toThrow(
      "no transport accepts target"
    )
  })

  test("overlapping routes refuse before either transport sends", async () => {
    let sent = 0
    const transport = (name: string): Transport<ActorId, ActorEnvelope> => ({
      name,
      send: () => {
        sent += 1
        return Effect.void
      }
    })
    const directory = mappedDirectory((id: ActorId) => id)
    const route = (name: string) => directoryRoute(transport(name), directory, isActorEnvelope, (envelope) => envelope.link.target)
    await expect(Effect.runPromise(sendThrough([
      route("local"),
      route("durable-object")
    ], envelopeOf(linkOf(source, localTarget), message)))).rejects.toThrow("multiple transports accept target")
    expect(sent).toBe(0)
  })
})
