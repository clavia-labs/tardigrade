import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/router"
import { Self } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "@clavia/tardigrade-host/host"
import { replyId } from "@clavia/tardigrade-core/message"
import { Park } from "@clavia/tardigrade-code/errors"
import { agentsPackage } from "./spawn"
import {
  formatActorAddress,
  parseActorAddress,
  type ActorAddress,
  type ProviderAddress
} from "@clavia/tardigrade-core/communication/address"
import type { Link } from "@clavia/tardigrade-core/communication/link"

// The package is a value: its three privileges arrive as services, so a test binds them the way
// a host does and the same value runs anywhere.

const REFUSED = Effect.succeed({ error: "no synchronous calls" })
type SentLink = Link<ActorAddress, ActorAddress> | Link<ActorAddress, ProviderAddress>

const env = (
  lane: string,
  sent: Array<{ readonly link: SentLink; readonly event: Event }>,
  lanes: Readonly<Record<string, ReadonlyArray<Event>>> = {}
) =>
  Layer.mergeAll(
    Layer.succeed(Router, {
      deliver: (link, event) => Effect.sync(() => void sent.push({ link, event })),
      call: () => REFUSED,
      resume: () => REFUSED
    }),
    Layer.succeed(Self, parseActorAddress(lane)),
    Layer.succeed(Facets, { read: (name: string) => Effect.succeed(lanes[name] ?? []) })
  )

describe("agentsPackage", () => {
  test("the default placement is the host's own sibling address", async () => {
    const host = createHost({ actorFor: () => undefined, principal: "mem" })
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage()
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c1" }).pipe(Effect.provide(env(host.self("ag.root"), sent)))
    )
    // Parity with the closure the in-process host used to pass: same principal, `ag.<callId>`
    // for the lane.
    expect(sent[0]?.link.target).toEqual({ actor: "mem", thread: "ag.c1" })
  })

  test("a stated place overrides the default", async () => {
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage({
      place: (callId, self) => ({
        actor: "far",
        thread: `${formatActorAddress(self)}/${callId}`
      })
    })
    await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c2" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(formatActorAddress(sent[0]!.link.target as ActorAddress)).toBe("far:mem:ag.root/c2")
  })

  test("the callId is the child's identity and the brief's id", async () => {
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage()
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "scout", background: true }, { callId: "c3" }).pipe(Effect.provide(env("mem:ag.root", sent)))
    )
    expect(answer).toEqual({ dispatched: true, callId: "c3" })
    const brief = sent[0]!.event as { id?: unknown; replyTo?: unknown }
    expect(brief.id).toBe("c3")
    expect(brief.replyTo).toBe("mem:ag.root")
  })

  test("a reply already on the lane answers without parking", async () => {
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [{ type: "MessageReceived", id: replyId("c4"), outcome: "completed", text: "4", at: 1 }]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c4" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
    )
    expect(answer).toEqual({ output: "4" })
    // The observe privilege answered, so nothing was re-delivered.
    expect(sent.length).toBe(0)
  })

  test("a foreground run with no reply yet parks on the reply row", async () => {
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage()
    const parked = await Effect.runPromise(
      pkg.methods.run!({ text: "sum 2+2" }, { callId: "c5" }).pipe(Effect.provide(env("mem:ag.root", sent)), Effect.flip)
    )
    expect(parked).toBeInstanceOf(Park)
    expect((parked as Park).awaiting).toBe(replyId("c5"))
    expect(formatActorAddress(sent[0]!.link.target as ActorAddress)).toBe("mem:ag.c5")
  })

  test("result reads the lane through Facets", async () => {
    const sent: Array<{ readonly link: SentLink; readonly event: Event }> = []
    const pkg = agentsPackage()
    const lanes = {
      "ag.root": [{ type: "MessageReceived", id: replyId("c6"), outcome: "failed", text: "error: nope", at: 1 }]
    } as Readonly<Record<string, ReadonlyArray<Event>>>
    const answer = await Effect.runPromise(
      pkg.methods.result!({ id: "c6" }, { callId: "c7" }).pipe(Effect.provide(env("mem:ag.root", sent, lanes)))
    )
    expect(answer).toEqual({ error: "nope" })
  })
})
