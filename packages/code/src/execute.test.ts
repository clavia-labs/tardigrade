import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Event } from "@tardigrade/core/event"
import { composeKeys, EventLog, withWatermark } from "@tardigrade/core/event-log"
import { settleActor } from "@tardigrade/core/actor"
import { messageKeys } from "@tardigrade/core/message"
import { Packages, type Package } from "./packages"
import { Sandbox, type Bindings } from "./sandbox"
import { Tmp } from "./tmp"
import { codeReactor } from "./execute"
import { codeKeys } from "./events"

// The shadow router rule, over the one funnel every package call crosses: `executeRecorded`. A
// shadow brief refuses an open-world write and an unannotated method (the same dangerous default
// `annotationsOf` takes), and lets a read or a closed-world write through untouched. A non-shadow
// brief takes none of these branches, ever.

const memSpill = () => {
  const store = new Map<string, string>()
  return Layer.succeed(Tmp, {
    store: (ref: string, json: string) => Effect.sync(() => void store.set(ref, json)),
    load: (ref: string) => Effect.sync(() => store.get(ref))
  })
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

const jsSandbox = Layer.succeed(Sandbox, {
  run: (code: string, bindings: Bindings) =>
    Effect.promise(async () => {
      try {
        const names = Object.keys(bindings)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => bindings[name])) }
      } catch (e) {
        return { error: String(e) }
      }
    })
})

const memoryLog = (initial: ReadonlyArray<Event>) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

// A read, a closed-world write, an open-world write, and a method that declares nothing: the four
// cells the router rule distinguishes.
const worldPackage: Package = {
  name: "world",
  description: "a package standing in for one owned surface and one open one",
  annotations: {
    read: { readOnlyHint: true, openWorldHint: true },
    ownedWrite: { readOnlyHint: false, openWorldHint: false },
    openWrite: { readOnlyHint: false, openWorldHint: true }
  },
  methods: {
    read: () => Effect.succeed({ ok: "read" }),
    ownedWrite: () => Effect.succeed({ ok: "ownedWrite" }),
    openWrite: () => Effect.succeed({ ok: "openWrite" }),
    mystery: () => Effect.succeed({ ok: "mystery" })
  }
}

const packagesLayer = Layer.succeed(Packages, {
  resolve: (name: string) => (name === "world" ? worldPackage : undefined),
  list: () => Effect.succeed([{ name: "world", description: worldPackage.description }])
})

const code = `
  const a = await world.read({})
  const b = await world.ownedWrite({})
  const c = await world.openWrite({})
  const d = await world.mystery({})
  return { a, b, c, d }
`

const settled = async (head: Event): Promise<ReadonlyArray<Event>> => {
  const log: Event[] = [head, { type: "CodeDispatched", execId: "e1", code, turn: "t1", at: 2 }]
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* settleActor({ reactors: [codeReactor], keyOf: composeKeys(messageKeys, codeKeys) })
      return yield* Effect.flatMap(EventLog, (l) => l.read)
    }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), packagesLayer, jsSandbox, memSpill()))) as Effect.Effect<ReadonlyArray<Event>>
  )
}

describe("transience never reaches the body", () => {
  // A package fn's transient failure (an RPC hiccup, a reset stub) must never surface as a
  // rejected promise the body can catch and branch on: a rejection is an input that exists
  // nowhere in the log, so it makes replay a function of infrastructure luck (the real run
  // run-d7b8b037-183, 2026-08-16: a post-delivery failure fed a `.catch` fallback and the
  // next attempt drifted). The failing call parks instead; the next attempt asks again.
  test("a transiently failing call parks and the re-drive gets the real answer", async () => {
    let attempts = 0
    const flakyPackage: Package = {
      name: "flaky",
      description: "fails once, then answers",
      annotations: { read: { readOnlyHint: true, openWorldHint: true } },
      methods: {
        read: () =>
          Effect.suspend(() => {
            attempts++
            return attempts === 1 ? Effect.die(new Error("transient RPC reset")) : Effect.succeed({ ok: "real" })
          })
      }
    }
    const flakyLayer = Layer.succeed(Packages, {
      resolve: (name: string) => (name === "flaky" ? flakyPackage : undefined),
      list: () => Effect.succeed([{ name: "flaky", description: flakyPackage.description }])
    })
    // The body's catch is the trap: if transience rejects, the fallback becomes data.
    const code = `
      const a = await flaky.read({}).catch(() => ({ fell: "back" }))
      return { a }
    `
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code, turn: "t1", at: 2 }
    ]
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [codeReactor], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), flakyLayer, jsSandbox, memSpill()))) as Effect.Effect<ReadonlyArray<Event>>
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { result?: { a: unknown } } | undefined
    expect(settle).toBeDefined()
    // The real answer, never the fallback: the first attempt parked on the transient failure
    // and appended no return; the second asked again and got the truth.
    expect(settle!.result?.a).toEqual({ ok: "real" })
    expect(attempts).toBe(2)
    // One send, one return: the transient attempt recorded nothing beyond the send.
    expect(events.filter((e) => e.type === "PackageCalled").length).toBe(1)
    expect(events.filter((e) => e.type === "PackageReturned").length).toBe(1)
  })
})

describe("the replay guard", () => {
  // A drifted body's question must never receive the recorded answer to a different one:
  // the attempt dies loud instead (tla/Replay.tla: Trusting fails RightAnswer, Guarded
  // holds it). The seeded log records world.read at position 0; this body asks
  // world.ownedWrite there.
  test("a body asking a different question at a recorded position fails loud", async () => {
    const drifting = `
      const a = await world.ownedWrite({})
      return { a }
    `
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code: drifting, turn: "t1", at: 2 },
      { type: "PackageCalled", callId: "e1.0", name: "world.read", arguments: {}, turn: "t1", at: 3 },
      { type: "PackageReturned", callId: "e1.0", result: { ok: "read" }, turn: "t1", at: 4 }
    ]
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [codeReactor], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), packagesLayer, jsSandbox, memSpill()))) as Effect.Effect<ReadonlyArray<Event>>
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { error?: string }
    expect(settle.error).toContain("nondeterministic body")
    expect(settle.error).toContain("world.ownedWrite")
    expect(settle.error).toContain("world.read")
  })

  test("drifted arguments at a recorded position fail loud too", async () => {
    const drifting = `
      const a = await world.read({ page: 2 })
      return { a }
    `
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code: drifting, turn: "t1", at: 2 },
      { type: "PackageCalled", callId: "e1.0", name: "world.read", arguments: { page: 1 }, turn: "t1", at: 3 },
      { type: "PackageReturned", callId: "e1.0", result: { ok: "read" }, turn: "t1", at: 4 }
    ]
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [codeReactor], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), packagesLayer, jsSandbox, memSpill()))) as Effect.Effect<ReadonlyArray<Event>>
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { error?: string }
    expect(settle.error).toContain("nondeterministic body")
    expect(settle.error).toContain("different arguments")
  })
})

describe("the shadow router rule", () => {
  test("a shadow brief runs reads and closed-world writes, refuses open-world writes and unannotated methods", async () => {
    const events = await settled({ type: "MessageReceived", id: "t1", text: "go", shadow: true, at: 1 })
    const settle = events.find((e) => e.type === "CodeSettled") as { result?: { a: unknown; b: unknown; c: unknown; d: unknown } }
    expect(settle.result?.a).toEqual({ ok: "read" })
    expect(settle.result?.b).toEqual({ ok: "ownedWrite" })
    expect(settle.result?.c).toMatchObject({ error: "shadow run: world.openWrite is an open-world write and does not execute in a shadow run" })
    expect(settle.result?.d).toMatchObject({ error: "shadow run: world.mystery is an open-world write and does not execute in a shadow run" })
    // The attempt still lands on the log: PackageCalled for every call, whatever the router did.
    const calls = events.filter((e) => e.type === "PackageCalled").map((e) => (e as { name?: unknown }).name)
    expect(calls).toEqual(["world.read", "world.ownedWrite", "world.openWrite", "world.mystery"])
  })

  test("a non-shadow brief runs every call exactly as before", async () => {
    const events = await settled({ type: "MessageReceived", id: "t1", text: "go", at: 1 })
    const settle = events.find((e) => e.type === "CodeSettled") as { result?: { a: unknown; b: unknown; c: unknown; d: unknown } }
    expect(settle.result).toEqual({
      a: { ok: "read" },
      b: { ok: "ownedWrite" },
      c: { ok: "openWrite" },
      d: { ok: "mystery" }
    })
  })
})
