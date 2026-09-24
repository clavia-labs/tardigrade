import { expect, test } from "bun:test"
import fc from "fast-check"
import { Context, Effect, Layer, Schema } from "effect"
import { actor, component, legacyActorMethod } from "../actor"
import type { TransitionContext } from "../transition/transition"
import { ActorCheckError, checkActor, replayActor, type ActorCheckContext, type ActorInvariants } from "./check"

class Delta extends Context.Service<Delta, { readonly next: Effect.Effect<number> }>()("stress/Delta") {}
const start = legacyActorMethod({
  input: Schema.Int,
  output: Schema.Void,
  event: ({ input }) => ({ type: "Started", value: input }),
  state: () => ({ status: "pending", output: undefined }),
})
interface Shape {
  readonly lanes: number
  readonly rounds: number
  readonly multiplier: number
  readonly concurrent: boolean
  readonly audit: boolean
}
const shapes = fc.record({
  lanes: fc.integer({ min: 1, max: 4 }),
  rounds: fc.integer({ min: 1, max: 8 }),
  multiplier: fc.integer({ min: -2, max: 2 }),
  concurrent: fc.boolean(),
  audit: fc.boolean(),
})
const makeActor = (shape: Shape, corrupt = false) => actor({
  name: "generated-actor",
  methods: { start },
  components: Array.from({ length: shape.lanes }, (_, lane) => component({
    name: `lane-${lane}`,
    initial: (): { readonly context?: TransitionContext; readonly round: number; readonly value: number } => ({ round: 0, value: 0 }),
    step: (state, event, context) => {
      if (event.type === "Started") return { context, round: 0, value: Number(event.value) }
      if (event.type !== "Advanced" || event.lane !== lane || !state.context?.matches("advance", event)) return state
      const round = state.round + 1
      return { ...(round < shape.rounds ? { context } : {}), round, value: Number(event.value) }
    },
    output: state => ({
      view: state.value,
      transitions: state.context === undefined ? [] : [state.context.effect("advance", {
        concurrent: shape.concurrent,
        input: { round: state.round, value: state.value },
        act: input => Effect.gen(function* () {
          const service = yield* Delta
          const delta = yield* service.next
          const value = input.value * shape.multiplier + delta + (corrupt && lane === 0 && input.round === shape.rounds - 1 ? 1 : 0)
          const event = { type: "Advanced", lane, round: input.round, delta, value }
          return shape.audit ? [{ type: "Audited", lane, round: input.round }, event] : [event]
        }),
      })],
    }),
  })),
})
const inputs = fc.record({ method: fc.constant("start" as const), input: fc.integer({ min: -10, max: 10 }) })
const services = ({ generate }: ActorCheckContext) => Layer.succeed(Delta, {
  next: Effect.sync(() => generate(fc.integer, { min: -5, max: 5 })),
})
const rules = (shape: Shape): ActorInvariants => ({
  arithmetic: ({ events }) => {
    const initial = Number(events.find(event => event.type === "Started")?.value ?? 0)
    const values = Array.from({ length: shape.lanes }, () => initial)
    const rounds = Array.from({ length: shape.lanes }, () => 0)
    for (const event of events) {
      if (event.type !== "Advanced") continue
      const lane = Number(event.lane)
      expect(event.round).toBe(rounds[lane]!)
      const expected = values[lane]! * shape.multiplier + Number(event.delta)
      expect(event.value).toBe(expected)
      values[lane] = expected
      rounds[lane] = rounds[lane]! + 1
    }
  },
})
const failureOf = async (operation: Promise<unknown>): Promise<ActorCheckError> => {
  try { await operation } catch (error) {
    if (error instanceof ActorCheckError) return error
    throw error
  }
  throw new Error("Expected the checker to find the injected defect")
}

test("generated actors preserve arithmetic across sequential and concurrent lanes", async () => {
  await fc.assert(fc.asyncProperty(shapes, async shape => {
    const report = await checkActor(makeActor(shape), { inputs, services, invariants: rules(shape), numRuns: 10, seed: 123, maxSteps: 100 })
    expect(report.status).toBe("passed")
    expect(report.numRuns).toBe(10)
  }), { seed: 711, numRuns: 40 })
}, 30_000)

test("generated actor defects shrink and replay to the same violating prefix", async () => {
  await fc.assert(fc.asyncProperty(shapes, async shape => {
    const subject = makeActor(shape, true)
    const invariants = rules(shape)
    const error = await failureOf(checkActor(subject, { inputs, services, invariants, numRuns: 1, seed: 456 }))
    expect(error.counterexample.failure?.invariant).toBe("arithmetic")
    expect(error.counterexample.events.at(-1)?.type).toBe("Advanced")
    const replay = await replayActor(subject, error.counterexample.example, { services, invariants })
    expect(replay.status).toBe("failed")
    expect(replay.failure?.invariant).toBe("arithmetic")
    expect(replay.events).toEqual(error.counterexample.events)
  }), { seed: 712, numRuns: 30 })
}, 30_000)

test("generated execution bounds distinguish resting from truncated cases", async () => {
  await fc.assert(fc.asyncProperty(shapes, fc.integer({ min: 1, max: 35 }), async (shape, maxSteps) => {
    const report = await checkActor(makeActor(shape), { inputs, services, invariants: rules(shape), numRuns: 1, seed: 1, maxSteps })
    expect(report.status).toBe(maxSteps < 1 + shape.lanes * shape.rounds ? "bounded" : "passed")
  }), { seed: 713, numRuns: 40 })
}, 30_000)

test("invalid generated method inputs fail validation and reproduce", async () => {
  const subject = makeActor({ lanes: 1, rounds: 1, multiplier: 1, concurrent: false, audit: false })
  const error = await failureOf(checkActor(subject, {
    inputs: fc.constant({ method: "start", input: Number.NaN }), services, numRuns: 1,
    invariants: { valid: () => true },
  }))
  expect(error.counterexample.failure?.kind).toBe("execution")
  expect(error.counterexample.events).toEqual([])
  const replay = await replayActor(subject, error.counterexample.example, { services, invariants: { valid: () => true } })
  expect(replay.failure?.kind).toBe("execution")
})

test("layer acquisition timeout interrupts the pending acquisition", async () => {
  let interrupted = false
  const subject = makeActor({ lanes: 1, rounds: 1, multiplier: 1, concurrent: false, audit: false })
  const error = await failureOf(checkActor(subject, {
    inputs: fc.constant({ method: "start", input: 0 }), numRuns: 1, timeoutMs: 25,
    services: () => Layer.effect(Delta, Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })))),
    invariants: { valid: () => true },
  }))
  expect(error.counterexample.failure?.kind).toBe("execution")
  expect(interrupted).toBe(true)
  expect(error.counterexample.events).toEqual([])
})

test("ordinary service calls run again during replay alongside generated values", async () => {
  let realCalls = 0
  const shape = { lanes: 1, rounds: 2, multiplier: 1, concurrent: false, audit: false }
  const mixed = (context: ActorCheckContext) => Layer.succeed(Delta, {
    next: Effect.sync(() => { realCalls++; return context.generate(fc.integer, { min: 1, max: 5 }) }),
  })
  const subject = makeActor(shape, true)
  const error = await failureOf(checkActor(subject, { inputs, services: mixed, invariants: rules(shape), numRuns: 1, seed: 2 }))
  const before = realCalls
  const replay = await replayActor(subject, error.counterexample.example, { services: mixed, invariants: rules(shape) })
  expect(realCalls - before).toBe(2)
  expect(replay.events).toEqual(error.counterexample.events)
})
