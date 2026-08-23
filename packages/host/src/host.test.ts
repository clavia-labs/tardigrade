import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/router"
import { transition, type Actor, type Reactor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "./host"
import { parseActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { threadCreated } from "@clavia/tardigrade-core/thread"

// The host against toy reactors, package-pure: no app vocabulary.
// A "player" lane answers every unanswered ping on its log with a pong
// delivered to the sender, up to a rally length, so two players and one
// serve exercise delivery, dirtying, and the drive loop's fairness.

const RALLY = 6

const str = (v: unknown): string => String(v ?? "")

const signal = (): { readonly promise: Promise<void>; readonly send: () => void } => {
  let send!: () => void
  const promise = new Promise<void>((resolve) => {
    send = resolve
  })
  return { promise, send }
}

// The rally's key table: the inbound by id (msg:), the answer by the inbound it answers (an:).
const rallyKeys = (e: Event): string | undefined => {
  const v = e as { id?: unknown }
  if (e.type === "MessageReceived") return `msg:${str(v.id)}`
  if (e.type === "Answered") return `an:${str(v.id)}`
  return undefined
}

const playerReactor = (me: string, opponent: string): Reactor<Router> =>
  (events) => {
    const answered = new Set(
      events.filter((e) => e.type === "Answered").map((e) => str((e as { id?: unknown }).id))
    )
    const pending = events.find(
      (e) => e.type === "MessageReceived" && !answered.has(str((e as { id?: unknown }).id))
    ) as { id?: unknown; n?: unknown } | undefined
    if (pending === undefined) return []
    const n = Number(pending.n ?? 0)
    return [
      transition({
        key: `an:${str(pending.id)}`,
        input: { id: str(pending.id), n },
        act: (input) =>
          Effect.gen(function* () {
            const router = yield* Router
            if (input.n < RALLY) {
              yield* router.send(envelopeOf(linkOf(parseActorId(`mem:${me}`), parseActorId(opponent)), {
                type: "MessageReceived",
                id: `${me}-${input.n + 1}`,
                n: input.n + 1,
                at: input.n + 1
              } as Event, me === "a" ? { parent: parseActorId("mem:a"), depth: 1 } : undefined))
            }
            return [{ type: "Answered", id: input.id, at: input.n } as Event]
          })
      })
    ]
  }

const rally = () => {
  const host = createHost<Router>({
    actorFor: (lane) =>
      lane === "a" ? { reactors: [playerReactor("a", "mem:b")], keyOf: rallyKeys }
      : lane === "b" ? { reactors: [playerReactor("b", "mem:a")], keyOf: rallyKeys }
      : undefined
  })
  return host
}

describe("the host", () => {
  test("settles distinct lanes up to the configured capacity", async () => {
    const release = signal()
    const twoStarted = signal()
    let active = 0
    let peak = 0
    let started = 0
    const actor: Actor = {
      keyOf: (event) => event.type === "Done" ? `done:${str((event as { id?: unknown }).id)}` : undefined,
      reactors: [(events) =>
        events
          .filter((event) => event.type === "MessageReceived")
          .map((event) => {
            const id = str((event as { id?: unknown }).id)
            return transition({
              key: `done:${id}`,
              input: id,
              act: (input: string) => Effect.promise(async () => {
                active += 1
                peak = Math.max(peak, active)
                started += 1
                if (started === 2) twoStarted.send()
                await release.promise
                active -= 1
                return [{ type: "Done", id: input, at: 1 } as Event]
              })
            })
          })]
    }
    const host = createHost({
      actorFor: () => actor,
      driver: { maxConcurrentLanes: 2 },
      keyOf: actor.keyOf
    })
    for (const lane of ["a", "b", "c"]) {
      host.commitRoot(`mem:${lane}`, { type: "MessageReceived", id: lane, at: 0 } as Event)
    }

    const driving = host.drive()
    await twoStarted.promise
    expect(active).toBe(2)
    expect(host.resting()).toBe(false)
    release.send()
    await driving

    expect(peak).toBe(2)
    expect(host.resting()).toBe(true)
    expect(["a", "b", "c"].map((lane) => host.read(lane).some((event) => event.type === "Done")))
      .toEqual([true, true, true])
  })

  test("one serve drives the whole rally to quiescence", async () => {
    const host = rally()
    host.commitRoot("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.resting()).toBe(true)
    const total =
      host.read("a").filter((e) => e.type === "Answered").length +
      host.read("b").filter((e) => e.type === "Answered").length
    expect(total).toBe(RALLY + 1)
  })

  test("redelivery is absorbed: same id, no second answer", async () => {
    const host = rally()
    host.commitRoot("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    const before = host.read("a").length
    host.commitRoot("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.read("a").length).toBe(before)
  })

  test("a sink lane takes deliveries and owes nothing", async () => {
    const host = rally()
    host.commitRoot("mem:reg", { type: "MessageReceived", id: "note", at: 1 } as Event)
    await host.drive()
    expect(host.read("reg").map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(host.resting()).toBe(true)
  })

  test("a child is created with its first delivery and keeps that lineage", () => {
    const host = createHost({ actorFor: () => undefined })
    const parent = parseActorId("mem:parent")
    const target = parseActorId("mem:child")
    const first = envelopeOf(
      linkOf(parent, target),
      { type: "MessageReceived", id: "m1", text: "work", at: 7 } as Event,
      { parent, depth: 1 }
    )
    host.commit(first)
    host.commit(first)
    expect(host.read("child")).toEqual([
      threadCreated(target, { parent, depth: 1 }, 7),
      { ...first.event, link: first.link }
    ])
    expect(() => host.commit(envelopeOf(
      linkOf(parseActorId("mem:other"), target),
      { type: "MessageReceived", id: "m2", text: "work", at: 8 } as Event,
      { parent: parseActorId("mem:other"), depth: 1 }
    ))).toThrow("already has different lineage")
  })

  test("an initial actor delivery must carry child lineage", () => {
    const host = createHost({ actorFor: () => undefined })
    expect(() => host.commit(envelopeOf(
      linkOf(parseActorId("mem:parent"), parseActorId("mem:child")),
      { type: "MessageReceived", id: "m1", text: "work", at: 1 } as Event
    ))).toThrow("must carry lineage")
    expect(host.read("child")).toEqual([])
  })
})

describe("the router membrane", () => {
  test("an unkeyed cross-lane event refuses loudly; a keyed one travels", () => {
    const host = createHost<never>({
      actorFor: () => undefined,
      keyOf: (e) => (e.type === "MessageReceived" || e.type === "Keyed" ? `k:${String((e as { id?: unknown }).id)}` : undefined)
    })
    expect(() => host.commitRoot("mem:lane", { type: "Rogue", at: 1 } as never)).toThrow(
      'unkeyed cross-lane event "Rogue"'
    )
    host.commitRoot("mem:lane", { type: "Keyed", id: "k1", at: 1 } as never)
    expect(host.read("lane").map((event) => event.type)).toEqual(["ThreadCreated", "Keyed"])
  })
})

describe("the observe privilege", () => {
  // All lanes share one store here, so the host binds Facets beside Router and Self: a lane reads
  // a sibling's committed events by name (packages/core/src/logs.ts, Facets).
  test("a lane reads a seeded sibling lane through Facets", async () => {
    const watcher: Reactor<Facets> = (events) =>
      events.some((e) => e.type === "Saw")
        ? []
        : [
            transition({
              key: "saw:one",
              input: null,
              act: () =>
                Effect.gen(function* () {
                  const logs = yield* Facets
                  const seen = yield* logs.read("other")
                  return [{ type: "Saw", n: seen.length, at: 1 } as Event]
                })
            })
          ]
    const host = createHost<Facets>({
      actorFor: (lane) => (lane === "watch" ? { reactors: [watcher], keyOf: (e) => (e.type === "Saw" ? "saw:one" : undefined) } : undefined)
    })
    host.seed("other", [threadCreated({ actor: "mem", thread: "other" }, undefined, 0), { type: "MessageReceived", id: "m1", text: "hi", at: 1 } as Event])
    host.seed("watch", [threadCreated({ actor: "mem", thread: "watch" }, undefined, 0)])
    await host.wake("watch")
    expect(host.read("watch").at(-1)).toEqual({ type: "Saw", n: 2, at: 1 })
  })
})
