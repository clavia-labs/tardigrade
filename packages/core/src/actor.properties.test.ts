import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import fc from "fast-check"
import { actorFromReactors, intent, settleActor, effect, type Reactor } from "./actor"
import type { Event } from "./event"
import { EventLog, withWatermark } from "./event-log"

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
