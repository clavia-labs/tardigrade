import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, composeKeys, withWatermark } from "@clavia/tardigrade-core/event-log"
import { settleActor } from "@clavia/tardigrade-core/actor"
import { messageKeys } from "@clavia/tardigrade-core/message"
import { definePackage, type Package } from "./packages"
import { Park } from "./errors"
import { codeKeys } from "./events"
import { codeReactorFor } from "./execute"
import { guestBindings, Sandbox, type Bindings } from "./sandbox"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

const jsSandbox = Layer.succeed(Sandbox, {
  run: (code: string, bindings: Bindings) =>
    Effect.promise(async () => {
      try {
        const scope = guestBindings(bindings)
        const names = Object.keys(scope)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => scope[name])) }
      } catch (error) {
        return { error: String(error) }
      }
    })
})

const memoryLog = (initial: ReadonlyArray<Event>) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

interface Completion {
  readonly kind: "park" | "ready"
  readonly delay: number
}

const ATTEMPT_TIMEOUT_MILLIS = 2_000

const probePackage: Package = definePackage({
  name: "probe",
  description: "Completes package calls in a stated order.",
  annotations: { finish: { readOnlyHint: true, openWorldHint: false } },
  methods: {
    finish: (args, ctx) => {
      const completion = args as Completion
      return Effect.sleep(`${completion.delay} millis`).pipe(
        Effect.flatMap(() =>
          completion.kind === "park"
            ? Effect.fail(new Park({ callId: ctx.callId, awaiting: `${ctx.callId}.reply` }))
            : Effect.succeed({ callId: ctx.callId })
        )
      )
    }
  }
})

const runAttempt = async (completions: ReadonlyArray<Completion>): Promise<ReadonlyArray<Event> | undefined> => {
  const calls = completions.map((completion) => `probe.finish(${JSON.stringify(completion)})`).join(",")
  const code = `return await Promise.all([${calls}])`
  const initial: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "t1", text: "go", at: 1 } as Event,
    { type: "CodeDispatched", execId: "e1", code, turn: "t1", at: 2 } as Event
  ]
  const running = Effect.runPromise(
    Effect.gen(function* () {
      yield* settleActor({
        reactors: [codeReactorFor({}, [probePackage])],
        keyOf: composeKeys(messageKeys, codeKeys)
      })
      return yield* Effect.flatMap(EventLog, (log) => log.read)
    }).pipe(Effect.provide(Layer.mergeAll(memoryLog(initial), jsSandbox, KeyValueStore.layerMemory))) as Effect.Effect<ReadonlyArray<Event>>
  )
  return Promise.race([
    running,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ATTEMPT_TIMEOUT_MILLIS))
  ])
}

const mixedCompletions = fc.integer({ min: 2, max: 6 }).chain((length) =>
  fc.tuple(
    fc.array(fc.constantFrom<Completion["kind"]>("park", "ready"), { minLength: length, maxLength: length })
      .filter((kinds) => kinds.includes("park") && kinds.includes("ready")),
    fc.shuffledSubarray([...Array(length).keys()], { minLength: length, maxLength: length })
  ).map(([kinds, order]) => {
    const rank = new Map(order.map((index, position) => [index, position]))
    return kinds.map((kind, index) => ({ kind, delay: (rank.get(index) ?? 0) * 2 }))
  })
)

describe("the mixed completion barrier", () => {
  test("a final ready call releases a parked attempt", async () => {
    const events = await runAttempt([
      { kind: "park", delay: 0 },
      { kind: "ready", delay: 10 }
    ])
    expect(events).toBeDefined()
  })

  test("every package completion order releases a parked attempt", async () => {
    await fc.assert(
      fc.asyncProperty(mixedCompletions, async (completions) => {
        const events = await runAttempt(completions)
        expect(events).toBeDefined()
        if (events === undefined) return
        expect(events.filter((event) => event.type === "BlockedOn")).toHaveLength(
          completions.filter((completion) => completion.kind === "park").length
        )
        expect(events.filter((event) => event.type === "PackageReturned")).toHaveLength(
          completions.filter((completion) => completion.kind === "ready").length
        )
      }),
      { numRuns: 100 }
    )
  })
})
