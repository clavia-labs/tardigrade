import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import fc from "fast-check"
import {
  actorFromProjections,
  enabled,
  settleActor,
  type Actor
} from "./index"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { completeTransitionProjection, type CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { EventLog, withWatermark } from "../log"

const actorFromCompleteDerivations = <R = never>(
  derivations: ReadonlyArray<CompleteTransitionDerivation<R>>,
  keyOf: (event: Event) => string | undefined = () => undefined,
  cancellationOf?: Actor<R>["cancellationOf"],
  cancellationResiduals?: Actor<R>["cancellationResiduals"]
) => actorFromProjections({
  transitions: derivations.map(completeTransitionProjection),
  keyOf,
  ...(cancellationOf === undefined && cancellationResiduals === undefined
    ? {}
    : {
      legacy: {
        ...(cancellationOf === undefined ? {} : { cancellationOf }),
        ...(cancellationResiduals === undefined ? {} : { cancellationResiduals })
      }
    })
})

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
    const runtime = actorFromCompleteDerivations([() => [
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
    const runtime = actorFromCompleteDerivations(
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

  test("independent cancellation effects start before either peer finishes", async () => {
    let started = 0
    let announceStarted: () => void = () => {}
    let release: () => void = () => {}
    const allStarted = new Promise<void>((resolve) => { announceStarted = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    const cleanup = (id: string) => effect({
      key: `cleanup:${id}`,
      input: id,
      act: (input) => Effect.promise(async () => {
        started += 1
        if (started === 2) announceStarted()
        await released
        return [{ type: "CleanupFinished", id: input } as Event]
      })
    })
    const runtime = actorFromCompleteDerivations(
      [],
      (event) => event.type === "CleanupFinished"
        ? `cleanup:${String((event as { readonly id?: unknown }).id)}`
        : undefined,
      undefined,
      () => [cleanup("one"), cleanup("two")]
    )
    const settling = Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memoryLog())))
    try {
      await Promise.race([
        allStarted,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cleanup effects started serially")), 1_000))
      ])
    } finally {
      release()
    }
    await settling
    expect(started).toBe(2)
  })

  test("a concurrent cancellation commit does not hide a wedged peer", async () => {
    const runtime = actorFromCompleteDerivations(
      [],
      (event) => event.type === "CleanupFinished"
        ? `cleanup:${String((event as { readonly id?: unknown }).id)}`
        : undefined,
      undefined,
      () => [
        effect({
          key: "cleanup:good",
          input: undefined,
          act: () => Effect.succeed([{ type: "CleanupFinished", id: "good" } as Event])
        }),
        effect({
          key: "cleanup:missing",
          input: undefined,
          act: () => Effect.succeed([{ type: "UnkeyedCleanup" } as Event])
        })
      ]
    )
    await expect(Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memoryLog()))))
      .rejects.toThrow('effect "cleanup:missing" wedged')
  })

  test("a committed intent invalidates every remaining transition from its snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (siblings) => {
        const projection: CompleteTransitionDerivation = (log) => {
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
        const runtime = actorFromCompleteDerivations([projection], (event) => {
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
