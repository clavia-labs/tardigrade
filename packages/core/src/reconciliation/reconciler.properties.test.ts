import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import fc from "fast-check"
import { actorFromReactors, enabled, intent, settleActor, effect, type Reactor } from "./index"
import type { Event } from "../log/event"
import { EventLog, withWatermark } from "../log"

const memoryLog = (initial: ReadonlyArray<Event> = []) =>
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

describe("actor reconciliation", () => {
  test("a cancellation tombstone disables owned effects before or after arrival", () => {
    const invocation = { method: "work", id: "w1", epoch: 2 } as const
    const runtime = actorFromReactors([() => [
      effect({ key: "owned", invocation, input: undefined, act: () => Effect.succeed([]) }),
      effect({ key: "other", invocation: { ...invocation, epoch: 3 }, input: undefined, act: () => Effect.succeed([]) })
    ]], () => undefined, (events, target) => events.some((event) =>
      event.type === "WorkStarted" &&
      String((event as { readonly id?: unknown }).id) === target.id &&
      Number((event as { readonly epoch?: unknown }).epoch) === target.epoch
    ) ? "running" : undefined)

    const started = { type: "WorkStarted", id: "w1", epoch: 2 } as Event
    const cancellation = { type: "CancellationRequested", request: "x1", invocation, cause: "requested" } as Event
    expect(enabled(runtime, [started, cancellation])
      .map((transition) => transition.key)).toEqual(["other"])
    expect(enabled(runtime, [cancellation, started])
      .map((transition) => transition.key)).toEqual(["other"])
  })

  test("cancellation residuals compose with actor continuations", () => {
    const invocation = { method: "work", id: "w1", epoch: 0 } as const
    const cleanup = effect({
      key: "cleanup",
      invocation,
      input: undefined,
      act: () => Effect.succeed([])
    })
    const runtime = actorFromReactors(
      [() => [effect({ key: "ordinary", input: undefined, act: () => Effect.succeed([]) })]],
      () => undefined,
      () => "running",
      (events) => events.some((event) => event.type === "CancellationRequested") ? [cleanup] : undefined
    )

    expect(enabled(runtime, [{ type: "CancellationRequested" } as Event])
      .map((transition) => transition.key)).toEqual(["ordinary", "cleanup"])
    expect(enabled(runtime, [])
      .map((transition) => transition.key)).toEqual(["ordinary"])
  })

  test("a committed intent invalidates every remaining transition from its snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (siblings) => {
        const reactor: Reactor = (log) => {
          if (log.some((event) => event.type === "SnapshotAdvanced")) return []
          return [
            intent({
              key: "advance",
              input: undefined,
              events: (_input, at) => [{ type: "SnapshotAdvanced", at }]
            }),
            ...Array.from({ length: siblings }, (_, index) =>
              effect({
                key: `stale:${index}`,
                input: index,
                act: (input) => Effect.succeed([{ type: "StaleCommitted", id: input }])
              })
            )
          ]
        }
        const runtime = actorFromReactors([reactor], (event) => {
          if (event.type === "SnapshotAdvanced") return "advance"
          if (event.type === "StaleCommitted") return `stale:${String((event as { id?: unknown }).id)}`
          return undefined
        })
        const settled = Effect.gen(function* () {
          yield* settleActor(runtime)
          return yield* Effect.flatMap(EventLog, (log) => log.read)
        })
        const log = await Effect.runPromise(settled.pipe(Effect.provide(memoryLog())))

        expect(log).toHaveLength(1)
        expect(log[0]).toMatchObject({ type: "SnapshotAdvanced" })
        expect(Number((log[0] as { at?: unknown }).at)).toBeGreaterThan(0)
      }),
      { numRuns: 100 }
    )
  })
})
