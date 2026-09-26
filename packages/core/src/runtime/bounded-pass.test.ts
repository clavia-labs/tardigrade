import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { component, type TransitionContext } from "../component"
import { transitionProjectionOf } from "../component/runtime"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "../log"
import { actorFromProjections, createActorReconciler } from "./index"
import type { ActorReconciler } from "./reconciler"

// These tests describe a settlement pass with a deadline. A host that cuts a handler at a fixed budget needs the pass to stop starting work before the cut, and to leave nothing in flight that the cut would drop. The option name is test-local, so maintainers can choose the public surface.

const STEPS = 5

// chain is an actor whose turn is five effects in sequence, each taking stepMs.
const chain = (stepMs: number, runs: Map<number, number>) => actorFromProjections({
  transitions: [transitionProjectionOf(component({
    name: "chain",
    initial: (): { readonly context?: TransitionContext; readonly done: number } => ({ done: 0 }),
    step: (state, event, context) => event.type === "Go" ? { ...state, context }
      : event.type === "Stepped" ? { ...state, done: state.done + 1 } : state,
    output: ({ context, done }) => ({
      view: done,
      transitions: context === undefined || done >= STEPS ? [] : [context.effect(`step/${done}`, {
        input: done,
        act: (n: number) => Effect.sync(() => runs.set(n, (runs.get(n) ?? 0) + 1)).pipe(
          Effect.andThen(Effect.sleep(stepMs)),
          Effect.as({ type: "Stepped", n })
        )
      })]
    })
  }))],
  keyOf: () => undefined
})

const memoryLog = (log: Ref.Ref<ReadonlyArray<Event>>) => Layer.succeed(EventLog, withWatermark({
  append: (events: ReadonlyArray<Event>) => Ref.update(log, current => [...current, ...events]),
  read: Ref.get(log)
}))

// passes settles one activation pass by pass, as a host alarm would, and records what each pass committed.
const passes = (stepMs: number, options: object) => Effect.gen(function* () {
  const runs = new Map<number, number>()
  const log = yield* Ref.make<ReadonlyArray<Event>>([{ type: "Go", at: 0 }])
  // The second argument is test-local.
  const reconciler = (createActorReconciler as (...args: ReadonlyArray<unknown>) => ActorReconciler<never>)(chain(stepMs, runs), options)
  const committed: Array<ReadonlyArray<unknown>> = []
  for (let pass = 0; pass < 2 * STEPS; pass++) {
    yield* reconciler.settle.pipe(Effect.provide(memoryLog(log)))
    committed.push((yield* Ref.get(log)).filter(event => event.type === "Stepped").map(event => event.n))
    if (reconciler.isResting()) break
  }
  return { committed, runs }
}).pipe(Effect.runPromise)

describe("a settlement pass yields at its deadline and a later pass continues", () => {
  test.failing("a pass that reaches its deadline leaves work owed, and later passes finish it without repeating any", async () => {
    const { committed, runs } = await passes(20, { passDeadlineMs: 30 })
    expect(committed[0]!.length).toBeGreaterThan(0)
    expect(committed[0]!.length).toBeLessThan(STEPS)
    expect(committed.at(-1)).toEqual([0, 1, 2, 3, 4])
    expect([...runs.values()]).toEqual([1, 1, 1, 1, 1])
  })

  test.failing("an effect still running at the deadline commits its result once, and no new effect starts after the deadline", async () => {
    const { committed, runs } = await passes(60, { passDeadlineMs: 10 })
    expect(committed[0]).toEqual([0])
    expect(committed.at(-1)).toEqual([0, 1, 2, 3, 4])
    expect(runs.get(0)).toBe(1)
  })
})
