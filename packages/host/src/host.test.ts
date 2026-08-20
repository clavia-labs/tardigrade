import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Router } from "@clavia/tardigrade-core/router"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { Facets } from "@clavia/tardigrade-core/facets"
import { createHost } from "./host"

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
              yield* router.deliver(opponent, {
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

// A lane whose one transition takes long enough to be interrupted, and counts its own runs. Two
// senders arriving together is the ordinary shape of an event-driven process: the count is what
// says whether the second one re-ran an effect the first was already running.
const slowLane = () => {
  const runs = { n: 0 }
  const doneKeys = (e: Event): string | undefined => (e.type === "Done" ? "dn:1" : undefined)
  const reactor: Reactor = (events) =>
    events.some((e) => e.type === "Done")
      ? []
      : [
          transition({
            key: "dn:1",
            input: null,
            act: () =>
              Effect.gen(function* () {
                runs.n += 1
                yield* Effect.sleep("5 millis")
                return [{ type: "Done", at: 1 } as Event]
              })
          })
        ]
  const host = createHost({
    actorFor: (lane) => (lane === "one" ? { reactors: [reactor], keyOf: doneKeys } : undefined),
    keyOf: doneKeys
  })
  host.seed("one", [{ type: "MessageReceived", id: "m1", text: "go", at: 1 } as Event])
  return { host, runs }
}

describe("the driver", () => {
  test("concurrent drives settle a lane once", async () => {
    const { host, runs } = slowLane()
    // Three senders, none of them awaiting the ones before it: the drive in flight takes the two
    // that follow as one coalesced follow-up pass, and the pass they share finds the work done.
    await Promise.all([host.wake("one"), host.wake("one"), host.wake("one")])
    expect(runs.n).toBe(1)
    expect(host.read("one").filter((e) => e.type === "Done")).toHaveLength(1)
    expect(host.resting()).toBe(true)
  })

  test("a drive requested mid-pass serves what its own delivery enabled", async () => {
    const { host } = slowLane()
    const first = host.wake("one")
    host.deliver("mem:one", { type: "MessageReceived", id: "m2", text: "again", at: 2 } as Event)
    // The second sender awaits a pass that started after its own event landed, so the answer it
    // waited for is on the log by the time it returns.
    await Promise.all([first, host.drive()])
    expect(host.read("one").map((e) => e.type)).toEqual(["MessageReceived", "MessageReceived", "Done"])
    expect(host.resting()).toBe(true)
  })

  test("recover() settles the owed work of every lane that has an actor", async () => {
    const { host, runs } = slowLane()
    // The seed did not wake the lane, so the owed Done exists only as a derivation over the log.
    expect(host.resting()).toBe(false)
    await host.recover()
    expect(runs.n).toBe(1)
    expect(host.resting()).toBe(true)
  })
})

// The alarm, over an application vocabulary the host knows nothing about: a `Reminder` states the
// instant, and the fact the host appends when it arrives is the owner's `Fired`.
const reminderKeys = (e: Event): string | undefined => {
  const id = str((e as { id?: unknown }).id)
  if (e.type === "Fired") return `fd:${id}`
  if (e.type === "Answered") return `an:${id}`
  return undefined
}

const answerFired: Reactor = (events) =>
  events
    .filter((e) => e.type === "Fired")
    .filter((e) => !events.some((f) => f.type === "Answered" && str((f as { id?: unknown }).id) === str((e as { id?: unknown }).id)))
    .map((e) => {
      const id = str((e as { id?: unknown }).id)
      return transition({
        key: `an:${id}`,
        input: id,
        act: (input: string) => Effect.succeed([{ type: "Answered", id: input, at: 2 } as Event])
      })
    })

// The due reminder: one with no `Fired` naming it. `repeat` keeps naming the same fact after it has
// landed, which is the misuse the host refuses.
const dueOf = (repeat: boolean) => (_lane: string, events: ReadonlyArray<Event>) => {
  const due = events.find(
    (e) =>
      e.type === "Reminder" &&
      (repeat || !events.some((f) => f.type === "Fired" && str((f as { id?: unknown }).id) === str((e as { id?: unknown }).id)))
  ) as { id?: unknown; at?: unknown } | undefined
  if (due === undefined) return undefined
  const id = str(due.id)
  return { at: Number(due.at), event: { type: "Fired", id, at: Number(due.at) } as Event }
}

const armed = (seeded: ReadonlyArray<Event>, repeat = false) => {
  const host = createHost({
    actorFor: (lane) => (lane === "one" ? { reactors: [answerFired], keyOf: reminderKeys } : undefined),
    keyOf: reminderKeys,
    alarm: dueOf(repeat)
  })
  host.seed("one", seeded)
  return host
}

const reminder = { type: "Reminder", id: "r1", at: Date.now() } as Event

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe("the platform alarm", () => {
  test("an armed lane wakes at its instant and settles the fact", async () => {
    const host = armed([reminder])
    await host.recover()
    await until(() => host.read("one").some((e) => e.type === "Answered"))
    expect(host.read("one").map((e) => e.type)).toEqual(["Reminder", "Fired", "Answered"])
    expect(host.resting()).toBe(true)
  })

  test("a lane with nothing due arms no timer", async () => {
    const host = armed([reminder, { type: "Fired", id: "r1", at: 1 } as Event])
    await host.recover()
    await until(() => host.read("one").some((e) => e.type === "Answered"))
    // The reminder already has its fact, so the projection finds nothing due and the log stops
    // growing where the settle left it.
    expect(host.read("one").filter((e) => e.type === "Fired")).toHaveLength(1)
    expect(host.resting()).toBe(true)
  })

  test("an alarm the log already records refuses to arm", async () => {
    // The fired fact is on the log and this alarm still names it, so the same instant would arm
    // forever. The arm refuses instead, and the caller asking for the drive hears it.
    const host = armed([reminder, { type: "Fired", id: "r1", at: 1 } as Event], true)
    await expect(host.recover()).rejects.toThrow('alarm for lane "one" names "Fired"')
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
