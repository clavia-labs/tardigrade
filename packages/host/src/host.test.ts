import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/router"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "./host"
import { parseActorAddress } from "@clavia/tardigrade-core/communication/address"
import { linkOf } from "@clavia/tardigrade-core/communication/link"

// The host against toy reactors, package-pure: no app vocabulary.
// A "player" lane answers every unanswered ping on its log with a pong
// delivered to the sender, up to a rally length, so two players and one
// serve exercise delivery, dirtying, and the drive loop's fairness.

const RALLY = 6

const str = (v: unknown): string => String(v ?? "")

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
              yield* router.deliver(linkOf(parseActorAddress(`mem:${me}`), parseActorAddress(opponent)), {
                type: "MessageReceived",
                id: `${me}-${input.n + 1}`,
                n: input.n + 1,
                at: input.n + 1
              } as Event)
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
  test("one serve drives the whole rally to quiescence", async () => {
    const host = rally()
    host.deliver("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.resting()).toBe(true)
    const total =
      host.read("a").filter((e) => e.type === "Answered").length +
      host.read("b").filter((e) => e.type === "Answered").length
    expect(total).toBe(RALLY + 1)
  })

  test("redelivery is absorbed: same id, no second answer", async () => {
    const host = rally()
    host.deliver("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    const before = host.read("a").length
    host.deliver("mem:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.read("a").length).toBe(before)
  })

  test("a sink lane takes deliveries and owes nothing", async () => {
    const host = rally()
    host.deliver("mem:reg", { type: "MessageReceived", id: "note", at: 1 } as Event)
    await host.drive()
    expect(host.read("reg")).toHaveLength(1)
    expect(host.resting()).toBe(true)
  })
})

describe("the router membrane", () => {
  test("an unkeyed cross-lane event refuses loudly; a keyed one travels", () => {
    const host = createHost<never>({
      actorFor: () => undefined,
      keyOf: (e) => (e.type === "MessageReceived" || e.type === "Keyed" ? `k:${String((e as { id?: unknown }).id)}` : undefined)
    })
    expect(() => host.deliver("mem:lane", { type: "Rogue", at: 1 } as never)).toThrow(
      'unkeyed cross-lane event "Rogue"'
    )
    host.deliver("mem:lane", { type: "Keyed", id: "k1", at: 1 } as never)
    expect(host.read("lane").length).toBe(1)
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
    host.seed("other", [{ type: "MessageReceived", id: "m1", text: "hi", at: 1 } as Event])
    await host.wake("watch")
    expect(host.read("watch")).toEqual([{ type: "Saw", n: 1, at: 1 }])
  })
})
