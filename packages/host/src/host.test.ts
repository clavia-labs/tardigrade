import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { effect } from "@clavia/tardigrade-core/effect"
import { completeTransitionProjection, transitionProjection, type ErasedTransitionProjection } from "@clavia/tardigrade-core/transition"
import type { Actor } from "@clavia/tardigrade-core/runtime"
import { createHost } from "./host"
import { parseThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { threadCreated } from "@clavia/tardigrade-core/thread"

// The host against toy reactors, package-pure: no app vocabulary.
// A "player" thread answers every unanswered ping on its log with a pong
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

const playerProjection = (me: string, opponent: string): ErasedTransitionProjection<Router> =>
  completeTransitionProjection((events) => {
    const answered = new Set(
      events.filter((e) => e.type === "Answered").map((e) => str((e as { id?: unknown }).id))
    )
    const pending = events.find(
      (e) => e.type === "MessageReceived" && !answered.has(str((e as { id?: unknown }).id))
    ) as { id?: unknown; n?: unknown } | undefined
    if (pending === undefined) return []
    const n = Number(pending.n ?? 0)
    return [
      effect({
        key: `an:${str(pending.id)}`,
        input: { id: str(pending.id), n },
        act: (input) =>
          Effect.gen(function* () {
            const router = yield* Router
            if (input.n < RALLY) {
              yield* router.send(envelopeOf(linkOf(parseThreadAddress(`mem:main:${me}`), parseThreadAddress(opponent)), {
                type: "MessageReceived",
                id: `${me}-${input.n + 1}`,
                n: input.n + 1,
                at: input.n + 1
              } as Event, me === "a" ? { parent: parseThreadAddress("mem:main:a"), depth: 1 } : undefined))
            }
            return [{ type: "Answered", id: input.id, at: input.n } as Event]
          })
      })
    ]
  })

const rally = () => {
  const host = createHost<Router>({
    actorFor: (thread) =>
      thread === "a" ? { projections: [playerProjection("a", "mem:main:b")], keyOf: rallyKeys }
      : thread === "b" ? { projections: [playerProjection("b", "mem:main:a")], keyOf: rallyKeys }
      : undefined
  })
  return host
}

describe("the host", () => {
  test("reuses an incremental projection across drives", async () => {
    let reductions = 0
    const actor: Actor = {
      keyOf: () => undefined,
      projections: [transitionProjection({
        initial: () => 0,
        step: (count: number) => {
          reductions += 1
          return count + 1
        },
        output: () => []
      })]
    }
    const host = createHost({ actorFor: () => actor })

    host.commitRoot("mem:main:root", { type: "First", at: 1 } as Event)
    await host.drive()
    host.commitRoot("mem:main:root", { type: "Second", at: 2 } as Event)
    await host.drive()

    expect(reductions).toBe(host.read("root").length)
  })

  test("a committed interruption stops live external work", async () => {
    const started = signal()
    const release = signal()
    let aborted = false
    const actor: Actor = {
      cancellationOf: (events, invocation) =>
        invocation.method === "message" && invocation.id === "m1" && invocation.epoch === 0 &&
        events.some((event) => event.type === "MessageReceived")
          ? "running"
          : undefined,
      keyOf: (event) => event.type === "LateResult"
        ? "late"
        : event.type === "CancellationRequested"
          ? "cancel:message/m1/0"
          : undefined,
      projections: [completeTransitionProjection((events) => {
        if (events.some((event) => event.type === "CancellationRequested")) return []
        if (!events.some((event) => event.type === "MessageReceived")) return []
        return [effect({
          key: "late",
          invocation: { method: "message", id: "m1", epoch: 0 },
          input: "m1",
          act: (_turn, controllerSignal) => Effect.promise(async (runtimeSignal) => {
            started.send()
            controllerSignal?.addEventListener("abort", () => {
              aborted = true
            }, { once: true })
            await release.promise
            if (runtimeSignal.aborted) return []
            return [{ type: "LateResult", at: 2 } as Event]
          })
        })]
      })]
    }
    const host = createHost({ actorFor: () => actor, keyOf: actor.keyOf })
    host.commitRoot("mem:main:root", { type: "MessageReceived", id: "m1", at: 1 } as Event)
    const driving = host.drive()
    await started.promise
    host.commitRoot("mem:main:root", {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "message", id: "m1", epoch: 0 },
      cause: "requested",
      at: 2
    } as Event)
    await driving
    release.send()

    expect(aborted).toBe(true)
    expect(host.read("root").some((event) => event.type === "LateResult")).toBe(false)
  })

  test("settles distinct threads up to the configured capacity", async () => {
    const release = signal()
    const twoStarted = signal()
    let active = 0
    let peak = 0
    let started = 0
    const actor: Actor = {
      keyOf: (event) => event.type === "Done" ? `done:${str((event as { id?: unknown }).id)}` : undefined,
      projections: [completeTransitionProjection((events) =>
        events
          .filter((event) => event.type === "MessageReceived")
          .map((event) => {
            const id = str((event as { id?: unknown }).id)
            return effect({
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
          }))]
    }
    const host = createHost({
      actorFor: () => actor,
      driver: { maxConcurrentThreads: 2 },
      keyOf: actor.keyOf
    })
    for (const thread of ["a", "b", "c"]) {
      host.commitRoot(`mem:main:${thread}`, { type: "MessageReceived", id: thread, at: 0 } as Event)
    }

    const driving = host.drive()
    await twoStarted.promise
    expect(active).toBe(2)
    expect(host.resting()).toBe(false)
    release.send()
    await driving

    expect(peak).toBe(2)
    expect(host.resting()).toBe(true)
    expect(["a", "b", "c"].map((thread) => host.read(thread).some((event) => event.type === "Done")))
      .toEqual([true, true, true])
  })

  test("one serve drives the whole rally to quiescence", async () => {
    const host = rally()
    host.commitRoot("mem:main:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.resting()).toBe(true)
    const total =
      host.read("a").filter((e) => e.type === "Answered").length +
      host.read("b").filter((e) => e.type === "Answered").length
    expect(total).toBe(RALLY + 1)
  })

  test("redelivery is absorbed: same id, no second answer", async () => {
    const host = rally()
    host.commitRoot("mem:main:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    const before = host.read("a").length
    host.commitRoot("mem:main:a", { type: "MessageReceived", id: "serve", n: 0, at: 0 } as Event)
    await host.drive()
    expect(host.read("a").length).toBe(before)
  })

  test("a sink thread takes deliveries and owes nothing", async () => {
    const host = rally()
    host.commitRoot("mem:main:reg", { type: "MessageReceived", id: "note", at: 1 } as Event)
    await host.drive()
    expect(host.read("reg").map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(host.resting()).toBe(true)
  })

  test("a child is created with its first delivery and keeps that lineage", () => {
    const host = createHost({ actorFor: () => undefined })
    const parent = parseThreadAddress("mem:main:parent")
    const target = parseThreadAddress("mem:main:child")
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
      linkOf(parseThreadAddress("mem:main:other"), target),
      { type: "MessageReceived", id: "m2", text: "work", at: 8 } as Event,
      { parent: parseThreadAddress("mem:main:other"), depth: 1 }
    ))).toThrow("already has different lineage")
  })

  test("an initial actor delivery must carry child lineage", () => {
    const host = createHost({ actorFor: () => undefined })
    expect(() => host.commit(envelopeOf(
      linkOf(parseThreadAddress("mem:main:parent"), parseThreadAddress("mem:main:child")),
      { type: "MessageReceived", id: "m1", text: "work", at: 1 } as Event
    ))).toThrow("must carry lineage")
    expect(host.read("child")).toEqual([])
  })
})

describe("the router membrane", () => {
  test("an unkeyed cross-thread event refuses loudly; a keyed one travels", () => {
    const host = createHost<never>({
      actorFor: () => undefined,
      keyOf: (e) => (e.type === "MessageReceived" || e.type === "Keyed" ? `k:${String((e as { id?: unknown }).id)}` : undefined)
    })
    expect(() => host.commitRoot("mem:main:thread", { type: "Rogue", at: 1 } as never)).toThrow(
      'unkeyed cross-thread event "Rogue"'
    )
    host.commitRoot("mem:main:thread", { type: "Keyed", id: "k1", at: 1 } as never)
    expect(host.read("thread").map((event) => event.type)).toEqual(["ThreadCreated", "Keyed"])
  })
})
