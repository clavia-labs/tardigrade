import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@tardigrade/core/event"
import { composeKeys, EventLog, withWatermark } from "@tardigrade/core/event-log"
import { settleActor } from "@tardigrade/core/actor"
import { messageKeys } from "@tardigrade/core/message"
import { DEFAULT_SANDBOX_POLICY, Sandbox } from "./sandbox"
import { jsSandbox, jsSandboxFor } from "./defaults"
import { codeReactor } from "./execute"
import { codeKeys } from "./events"
import { Packages } from "./packages"

// Console capture: a body's prints come back on the result's `logs`, capped, and ride the
// settle so the model reads them beside the result (TODO.md item 8: a print-to-inspect habit
// used to read as a null result and send agents into API archaeology).

const run = (code: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* Sandbox
      return yield* sandbox.run(code, {})
    }).pipe(Effect.provide(jsSandbox))
  )

describe("jsSandbox console capture", () => {
  test("printed lines come back beside the result", async () => {
    const outcome = await run('console.log("a", 1); console.warn("b"); return 42')
    expect(outcome.result).toBe(42)
    expect(outcome.logs).toEqual(["a 1", "b"])
  })

  test("a silent body carries no logs key", async () => {
    const outcome = await run("return 7")
    expect(outcome.result).toBe(7)
    expect("logs" in outcome).toBe(false)
  })

  test("a throwing body still returns what it printed", async () => {
    const outcome = await run('console.log("before the fall"); throw new Error("boom")')
    expect(outcome.error).toContain("boom")
    expect(outcome.logs).toEqual(["before the fall"])
  })

  test("the cap bounds a print loop and says where it cut", async () => {
    const outcome = await run('for (let i = 0; i < 1000; i++) console.log("x".repeat(100)); return "done"')
    expect(outcome.result).toBe("done")
    const total = (outcome.logs ?? []).reduce((n, l) => n + l.length, 0)
    expect(total).toBeLessThanOrEqual(DEFAULT_SANDBOX_POLICY.logCapBytes + 200)
    expect((outcome.logs ?? []).length).toBeLessThan(1000)
    expect((outcome.logs ?? []).at(-1)).toContain(`cut at ${DEFAULT_SANDBOX_POLICY.logCapBytes} bytes`)
  })

  test("the cap is the consumer's: a stated one bounds the same loop lower", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run('for (let i = 0; i < 100; i++) console.log("x".repeat(100)); return "done"', {})
      }).pipe(Effect.provide(jsSandboxFor({ logCapBytes: 500 })))
    )
    const total = (outcome.logs ?? []).reduce((n, l) => n + l.length, 0)
    expect(total).toBeLessThanOrEqual(500 + 200)
    expect((outcome.logs ?? []).at(-1)).toContain("cut at 500 bytes")
  })
})

describe("replay-stable ambients", () => {
  const AMBIENT = { at: 1786900000000, seed: "e1" }
  const runWith = (code: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run(code, {}, AMBIENT)
      }).pipe(Effect.provide(jsSandbox))
    )

  test("the clock answers the dispatch instant, identically on every attempt", async () => {
    const code = 'return { now: Date.now(), iso: new Date().toISOString(), real: new Date(5).getTime() }'
    const first = await runWith(code)
    const second = await runWith(code)
    expect(first.result).toEqual(second.result)
    const r = first.result as { now: number; iso: string; real: number }
    expect(r.now).toBe(AMBIENT.at)
    expect(r.iso).toBe(new Date(AMBIENT.at).toISOString())
    // An explicit argument is data, never ambient: it stays untouched.
    expect(r.real).toBe(5)
  })

  test("randomness walks the same seeded stream on every attempt", async () => {
    const code = "return [Math.random(), Math.random(), Math.abs(-2)]"
    const first = await runWith(code)
    const second = await runWith(code)
    expect(first.result).toEqual(second.result)
    const [a, b, abs] = first.result as [number, number, number]
    expect(a).not.toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
    // The rest of Math is untouched.
    expect(abs).toBe(2)
  })

  test("a different execution seeds a different stream", async () => {
    const other = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox
        return yield* sandbox.run("return Math.random()", {}, { at: AMBIENT.at, seed: "e2" })
      }).pipe(Effect.provide(jsSandbox))
    )
    const first = await runWith("return Math.random()")
    expect(first.result).not.toBe(other.result)
  })
})

const memoryLog = (initial: ReadonlyArray<Event>) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        read: Ref.get(ref),
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events])
      })
    })
  )

const packagesLayer = Layer.succeed(Packages, {
  resolve: () => undefined,
  list: () => Effect.succeed([])
})

describe("logs ride the settle", () => {
  test("CodeSettled carries the body's prints", async () => {
    const log: Event[] = [
      { type: "MessageReceived", id: "t1", text: "go", at: 1 },
      { type: "CodeDispatched", execId: "e1", code: 'console.log("seen"); return "ok"', turn: "t1", at: 2 }
    ]
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor({ reactors: [codeReactor], keyOf: composeKeys(messageKeys, codeKeys) })
        return yield* Effect.flatMap(EventLog, (l) => l.read)
      }).pipe(Effect.provide(Layer.mergeAll(memoryLog(log), packagesLayer, jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<
        ReadonlyArray<Event>
      >
    )
    const settle = events.find((e) => e.type === "CodeSettled") as { result?: unknown; logs?: ReadonlyArray<string> }
    expect(settle.result).toBe("ok")
    expect(settle.logs).toEqual(["seen"])
  })
})
