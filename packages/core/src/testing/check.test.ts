import { expect, test } from "bun:test"
import fc from "fast-check"
import { Context, Effect, Layer, Schema } from "effect"
import { actor, component, legacyActorMethod } from "../actor"
import type { TransitionContext } from "../transition/transition"
import { ActorCheckError, checkActor, replayActor, type ActorCheckContext } from "./check"

class Reading extends Context.Service<Reading, { readonly read: (input: number) => Effect.Effect<number> }>()("test/Reading") {}
const measure = legacyActorMethod({
  input: Schema.Finite,
  output: Schema.Finite,
  event: ({ input, invocation }) => ({ type: "Requested", id: invocation.id, value: input }),
  state: events => {
    const done = events.find(event => event.type === "Measured")
    return done === undefined ? { status: "pending" } : { status: "completed", output: Number(done.value) }
  },
})
const sensor = actor({
  name: "sensor",
  methods: { measure },
  components: [component({
    name: "measurement",
    initial: (): { readonly context?: TransitionContext; readonly value: number } => ({ value: 0 }),
    step: (state, event, context) => event.type === "Requested"
      ? { context, value: Number(event.value) }
      : state.context?.matches("read", event) ? { value: state.value } : state,
    output: state => ({
      view: state.value,
      transitions: state.context === undefined ? [] : [state.context.effect("read", {
        input: state.value,
        act: input => Effect.gen(function* () {
          const reading = yield* Reading
          return { type: "Measured", value: yield* reading.read(input) }
        }),
      })],
    }),
  })],
})
const inputs = fc.record({ method: fc.constant("measure" as const), input: fc.integer({ min: 0, max: 100 }) })
const services = ({ generate }: ActorCheckContext) => Layer.succeed(Reading, {
  read: () => Effect.sync(() => generate(fc.integer, { min: 0, max: 100 })),
})

test("core checks ordinary actor methods with generated services and no inference", async () => {
  const seen = new Set<number>()
  const report = await checkActor(sensor, {
    inputs, services, numRuns: 20, seed: 42,
    invariants: { valid: ({ events }) => {
      for (const event of events) if (event.type === "Measured") {
        expect(event.value).toBeGreaterThanOrEqual(0)
        seen.add(Number(event.value))
      }
    } },
  })
  expect(report.status).toBe("passed")
  expect(seen.size).toBeGreaterThan(1)
  expect(report.policy).not.toHaveProperty("contextWindowTokens")
})

test("core shrinks and replays generated dependency values", async () => {
  const invariants = { small: ({ events }: { events: ReadonlyArray<{ readonly type: string; readonly value?: unknown }> }) => {
    for (const event of events) if (event.type === "Measured") expect(Number(event.value)).toBeLessThan(3)
  } }
  let failure: ActorCheckError | undefined
  try {
    await checkActor(sensor, { inputs, services, invariants, numRuns: 20, seed: 42 })
  } catch (error) {
    if (!(error instanceof ActorCheckError)) throw error
    failure = error
  }
  expect(failure).toBeDefined()
  expect(failure!.counterexample.example.choices).toEqual([3])
  expect(failure!.counterexample.example.input.input).toBe(0)
  const replay = await replayActor(sensor, failure!.counterexample.example, { services, invariants })
  expect(replay.failure?.invariant).toBe("small")
  expect(replay.events.at(-1)?.value).toBe(3)
})

test("core records generator failures even when a service handles the thrown error", async () => {
  await expect(checkActor(sensor, {
    inputs, numRuns: 1,
    services: ({ generate }) => Layer.succeed(Reading, {
      read: () => Effect.sync(() => {
        try { return generate(() => { throw new Error("generator broke") }) } catch { return 0 }
      }),
    }),
    invariants: { valid: () => true },
  })).rejects.toThrow(ActorCheckError)
})
