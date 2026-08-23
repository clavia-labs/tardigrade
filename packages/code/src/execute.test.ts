import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/event"
import { composeKeys, EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { settleActor, type Reactor } from "@clavia/tardigrade-core/actor"
import { messageKeys } from "@clavia/tardigrade-core/message"
import { definePackage, type Package } from "./packages"
import { Sandbox, type Bindings } from "./sandbox"
import { codeReactor, codeReactorFor } from "./execute"
import { codeKeys } from "./events"

// The shadow router rule, over the one funnel every package call crosses: `executeRecorded`. A
// shadow brief refuses an open-world write and an unannotated method (the same dangerous default
// `annotationsOf` takes), and lets a read or a closed-world write through untouched. A non-shadow
// brief takes none of these branches, ever.

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
const worldPackage: Package = definePackage({
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
      yield* settleActor({ reactors: [codeReactorFor({}, [worldPackage])], keyOf: composeKeys(messageKeys, codeKeys) })
      return yield* Effect.flatMap(EventLog, (l) => l.read)
    }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<ReadonlyArray<Event>>
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
    const flakyPackage: Package = definePackage({
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
        yield* settleActor({ reactors: [codeReactorFor({}, [flakyPackage])], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<ReadonlyArray<Event>>
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
  // the attempt dies loud instead (tla/runtime/Replay.tla: Trusting fails RightAnswer, Guarded
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
        yield* settleActor({ reactors: [codeReactorFor({}, [worldPackage])], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<ReadonlyArray<Event>>
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
        yield* settleActor({ reactors: [codeReactorFor({}, [worldPackage])], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<ReadonlyArray<Event>>
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

describe("the spill bound", () => {
  // The bound is the consumer's: a settle over it carries a pointer instead of the value, and the
  // preview length is stated the same way (tmp.ts, SpillPolicy).
  test("a stated bound spills a value the default would have kept whole", async () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code: 'return "q".repeat(60)', turn: "t1", at: 2 }
    ]
    const drive = (reactor: typeof codeReactor) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* settleActor({ reactors: [reactor], keyOf: composeKeys(messageKeys, codeKeys) })
          return yield* Effect.flatMap(EventLog, (l) => l.read)
        }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<
          ReadonlyArray<Event>
        >
      )
    const spilled = (await drive(codeReactorFor({ spill: { spillBytes: 10, previewChars: 4 } }, []))).find(
      (e) => e.type === "CodeSettled"
    ) as { tmp?: string; size?: number; preview?: string; result?: unknown }
    expect(spilled.tmp).toBe("e1.result")
    expect(spilled.size).toBe(62)
    expect(spilled.preview).toBe('"qqq')
    const whole = (await drive(codeReactor)).find((e) => e.type === "CodeSettled") as { tmp?: string; result?: unknown }
    expect(whole.tmp).toBeUndefined()
    expect(whole.result).toBe("q".repeat(60))
  })
})

describe("the pointer's note", () => {
  // The note is policy (store.ts, SpillPolicy): every bounded result tells the model how to read
  // the value back, so the words must name a call the mounted scope answers.
  const drive = (log: Event[], reactor: typeof codeReactor) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [reactor], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<
        ReadonlyArray<Event>
      >
    )
  const bigLog = (): Event[] => [
    { type: "MessageReceived", id: "t1", text: "go", at: 1 },
    { type: "CodeDispatched", execId: "e1", code: 'return "q".repeat(60)', turn: "t1", at: 2 }
  ]

  test("a scope with no workspace package gets a note with no verb", async () => {
    const events = await drive(bigLog(), codeReactorFor({ spill: { spillBytes: 10, previewChars: 4 } }, []))
    const settle = events.find((e) => e.type === "CodeSettled") as { note?: string }
    expect(settle.note).toContain("ref 'e1.result'")
    expect(settle.note).not.toContain("workspace.read")
  })

  test("a stated note overrides the derived one", async () => {
    const events = await drive(
      bigLog(),
      codeReactorFor({ spill: { spillBytes: 10, previewChars: 4, note: (ref) => `files.open({ref: '${ref}'})` } }, [])
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { note?: string }
    expect(settle.note).toBe("files.open({ref: 'e1.result'})")
  })

  test("a workspace whose read takes no ref refuses at construction", () => {
    const shadow: Package = definePackage({
      name: "workspace",
      description: "a path-only reader standing where the spill reader is expected",
      docs: {
        read: {
          description: "reads a file",
          input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          output: { type: "object", properties: { ok: { type: "boolean" } } }
        }
      },
      methods: { read: () => Effect.succeed({ ok: true }) }
    })
    expect(() => codeReactorFor({}, [shadow])).toThrow(/spill pointer/)
    // A stated note lifts the refusal: the consumer then owns the words.
    expect(() => codeReactorFor({ spill: { note: (ref) => ref } }, [shadow])).not.toThrow()
  })

  test("a workspace without the advertised grep refuses at construction", () => {
    const shadow: Package = definePackage({
      name: "workspace",
      description: "a reader without search",
      docs: {
        read: {
          description: "reads a ref",
          input: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
          output: { type: "object", properties: { ok: { type: "boolean" } } }
        }
      },
      methods: { read: () => Effect.succeed({ ok: true }) }
    })
    expect(() => codeReactorFor({}, [shadow])).toThrow(/workspace\.grep/)
  })
})

describe("a package's requirements ride its type", () => {
  // A package that reaches for a service names it in its type, and the reactor that runs the
  // package declares the same requirement, so the environment that drives the lane must provide
  // it. The funnel is what makes this true at run time: every method runs under the attempt's own
  // context (execute.ts, executeRecorded).
  class Ticker extends Context.Service<Ticker, string>()("code/test/Ticker") {}

  const tickerPackage: Package<Ticker> = definePackage({
    name: "ticker",
    description: "answers with the value the environment bound",
    annotations: { now: { readOnlyHint: true, openWorldHint: false } },
    methods: {
      now: () =>
        Effect.gen(function* () {
          return { tick: yield* Ticker }
        })
    }
  })

  test("a package method reads its service through the funnel", async () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code: "return await ticker.now({})", turn: "t1", at: 2 }
    ]
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [codeReactorFor({}, [tickerPackage])], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryLog(log),
            jsSandbox,
            KeyValueStore.layerMemory,
            Layer.succeed(Ticker, "bound")
          )
        )
      ) as Effect.Effect<ReadonlyArray<Event>>
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { result?: { tick?: string }; error?: string }
    expect(settle.error).toBeUndefined()
    // The value the environment bound, carried into the method's own effect by the attempt's
    // context: the requirement is real work, not a phantom type parameter.
    expect(settle.result?.tick).toBe("bound")
  })

  test("the reactor a service-needing package builds cannot stand where the service is missing", () => {
    // The packages are values, so the reactor's environment is derived from them: mounting the
    // ticker package makes a Reactor<KeyValueStore | Ticker>, and the powerless environment has
    // nowhere to read Ticker from. The type says so before anything runs.
    const powered: Reactor<KeyValueStore.KeyValueStore | Ticker> = codeReactorFor({}, [tickerPackage])
    // @ts-expect-error a Reactor<KeyValueStore | Ticker> is not a Reactor<KeyValueStore>
    const powerless: Reactor<KeyValueStore.KeyValueStore> = powered
    expect(powerless([])).toEqual([])
  })

  test("two packages under one name fail at construction", () => {
    // One name, one object in the body's scope: a second package under it would decide which
    // methods the code reaches by list order (execute.ts, codeReactorFor).
    expect(() => codeReactorFor({}, [tickerPackage, { ...tickerPackage, description: "another" }])).toThrow(
      'package "ticker" declared twice'
    )
  })
})
