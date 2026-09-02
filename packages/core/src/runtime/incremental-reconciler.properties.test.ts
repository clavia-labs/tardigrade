import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import fc from "fast-check"
import {
  actorFromProjections,
  createActorReconciler,
  enabled
} from "./index"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { completeTransitionProjection, transitionProjection, type CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { EventLog, withWatermark } from "../log"

const actorFromCompleteDerivations = <R = never>(
  derivations: ReadonlyArray<CompleteTransitionDerivation<R>>,
  keyOf: (event: Event) => string | undefined = () => undefined,
  cancellationOf?: Parameters<typeof actorFromProjections<R>>[2],
  cancellationResiduals?: Parameters<typeof actorFromProjections<R>>[3],
  guards?: ReadonlyArray<CompleteTransitionDerivation<R>>,
  control?: Parameters<typeof actorFromProjections<R>>[5]
) => {
  const projections = derivations.map(completeTransitionProjection)
  return actorFromProjections(
    projections,
    keyOf,
    cancellationOf,
    cancellationResiduals,
    guards?.map((guard) => {
      const index = derivations.indexOf(guard)
      return index === -1 ? completeTransitionProjection(guard) : projections[index]!
    }),
    control
  )
}

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
  test("incremental output agrees with complete replay", () => {
    const incremental = transitionProjection({
      initial: () => 0,
      step: (balance: number, event: Event) => balance + (event.type === "Added" ? 1 : -1),
      output: (balance: number) => balance > 0
        ? [intent({ key: `balance:${balance}`, input: undefined, events: () => [] })]
        : []
    })
    const complete: CompleteTransitionDerivation = (events) => {
      const balance = events.reduce((value, event) => value + (event.type === "Added" ? 1 : -1), 0)
      return balance > 0
        ? [intent({ key: `balance:${balance}`, input: undefined, events: () => [] })]
        : []
    }

    fc.assert(fc.property(
      fc.array(fc.boolean(), { maxLength: 100 }),
      (choices) => {
        const events = choices.map((added) => ({ type: added ? "Added" : "Removed" }) as Event)
        expect(replayProjection(incremental, events).map((transition) => transition.key))
          .toEqual(complete(events).map((transition) => transition.key))
      }
    ))
  })

  test("an activation cursor reduces each durable event once", async () => {
    const events: Array<Event> = [{ type: "Added" } as Event]
    let completeReads = 0
    let reductions = 0
    const tailMarks: Array<number> = []
    const log = Layer.succeed(EventLog, {
      append: (batch: ReadonlyArray<Event>) => Effect.sync(() => { events.push(...batch) }),
      read: Effect.sync(() => {
        completeReads += 1
        return [...events]
      }),
      head: Effect.sync(() => events.length),
      readFrom: (mark: number) => Effect.sync(() => {
        tailMarks.push(mark)
        return events.slice(mark)
      })
    })
    const reactor = transitionProjection({
      initial: () => 0,
      step: (count: number) => {
        reductions += 1
        return count + 1
      },
      output: () => []
    })
    const reconciler = createActorReconciler(actorFromProjections([reactor], () => undefined))

    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))
    events.push({ type: "Added" } as Event, { type: "Added" } as Event)
    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))
    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))

    expect(completeReads).toBe(1)
    expect(reductions).toBe(3)
    expect(tailMarks).toEqual([1, 3])
  })

  test("a reconciler reports whether its last settlement reached rest", async () => {
    const quiet = createActorReconciler(actorFromProjections([], () => undefined))
    expect(quiet.isResting()).toBe(false)
    await Effect.runPromise(quiet.settle.pipe(Effect.provide(memoryLog())))
    expect(quiet.isResting()).toBe(true)

    const blocked = createActorReconciler(actorFromCompleteDerivations([
      () => [effect({ key: "blocked", input: undefined, act: () => Effect.succeed([]) })]
    ]))
    await Effect.runPromise(blocked.settle.pipe(Effect.provide(memoryLog())))
    expect(blocked.isResting()).toBe(false)
  })

  test("an activation cursor reduces each control event once", async () => {
    const events: Array<Event> = [{ type: "Added" } as Event]
    let reductions = 0
    const log = Layer.succeed(EventLog, {
      append: (batch: ReadonlyArray<Event>) => Effect.sync(() => { events.push(...batch) }),
      read: Effect.sync(() => [...events]),
      head: Effect.sync(() => events.length),
      readFrom: (mark: number) => Effect.sync(() => events.slice(mark))
    })
    const control = {
      initial: () => 0,
      reduce: (count: unknown) => {
        reductions += 1
        return Number(count) + 1
      },
      cancellationOf: () => undefined,
      suppresses: () => false,
      residuals: () => undefined
    }
    const reconciler = createActorReconciler(actorFromCompleteDerivations(
      [],
      () => undefined,
      undefined,
      undefined,
      undefined,
      control
    ))

    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))
    events.push({ type: "Added" } as Event, { type: "Added" } as Event)
    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))
    await Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))

    expect(reductions).toBe(3)
  })

  test("a control projection never falls through to complete replay", () => {
    const invocation = { method: "work", id: "w1", epoch: 0 } as const
    const runtime = actorFromCompleteDerivations(
      [() => [effect({ key: "work", invocation, input: undefined, act: () => Effect.succeed([]) })]],
      () => undefined,
      () => { throw new Error("legacy cancellation replayed") },
      () => { throw new Error("legacy residuals replayed") },
      undefined,
      {
        initial: () => undefined,
        reduce: (state) => state,
        cancellationOf: () => undefined,
        suppresses: () => false,
        residuals: () => undefined
      }
    )

    expect(enabled(runtime, []).map((transition) => transition.key)).toEqual(["work"])
  })

  test("an unresolved guard suppresses component output", () => {
    let componentDerivations = 0
    const component: CompleteTransitionDerivation = () => {
      componentDerivations += 1
      return [intent({ key: "component", input: undefined, events: () => [] })]
    }
    const guard: CompleteTransitionDerivation = (events) => events.some((event) => event.type === "InputRejected")
      ? []
      : [intent({ key: "validation", input: undefined, events: () => [] })]
    const actor = actorFromCompleteDerivations(
      [component, guard],
      (event) => event.type === "InputRejected" ? "validation" : undefined,
      undefined,
      undefined,
      [guard]
    )

    expect(enabled(actor, []).map((transition) => transition.key)).toEqual(["validation"])
    expect(componentDerivations).toBe(0)
    expect(enabled(actor, [{ type: "InputRejected" } as Event]).map((transition) => transition.key))
      .toEqual(["component"])
    expect(componentDerivations).toBe(1)
  })

})
