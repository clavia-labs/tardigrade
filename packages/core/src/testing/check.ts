import fc from "fast-check"
import { Effect, Layer } from "effect"
import type { Actor } from "@clavia/tardigrade-core/actor/definition"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf, createActorReconciler, Self } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"

export const DEFAULT_ACTOR_CHECK = {
  numRuns: 100,
  maxSteps: 100,
  timeoutMs: 5_000,
} as const

export type ActorCheckInput<M extends ActorMethods> = {
  [K in keyof M & string]: { readonly method: K; readonly input: M[K]["input"]["Type"] }
}[keyof M & string]

export interface ActorCheckState {
  readonly events: ReadonlyArray<Event>
}
export type ActorInvariants = Readonly<Record<string, (state: ActorCheckState) => void | boolean>>
export type ActorCheckPorts = EventLog | Self | Router | ThreadAllocator

export interface ActorCheckContext {
  readonly generate: <T, Args extends unknown[]>(arbitrary: (...args: Args) => fc.Arbitrary<T>, ...args: Args) => T
}

type Services<R> = [Exclude<R, ActorCheckPorts>] extends [never]
  ? { readonly services?: (context: ActorCheckContext) => Layer.Layer<Exclude<R, ActorCheckPorts>> }
  : { readonly services: (context: ActorCheckContext) => Layer.Layer<Exclude<R, ActorCheckPorts>> }

export interface ActorCheckPolicy {
  /** maxSteps bounds committed event batches, including the initial input. */
  readonly maxSteps?: number
  /** timeoutMs bounds each execution, including service construction. */
  readonly timeoutMs?: number
}

export type ActorCaseOptions<R> = ActorCheckPolicy & Services<R> & {
  readonly invariants: ActorInvariants
}
export type ActorCheckOptions<R, M extends ActorMethods> = ActorCaseOptions<R> & {
  readonly inputs: fc.Arbitrary<ActorCheckInput<M>>
  readonly numRuns?: number
  readonly seed?: number
}

export interface ActorCase<M extends ActorMethods = ActorMethods> {
  readonly input: ActorCheckInput<M>
  readonly choices: ReadonlyArray<unknown>
  readonly policy?: ActorCheckPolicy
}
export interface ActorCaseResult<M extends ActorMethods = ActorMethods> extends ActorCheckState {
  readonly status: "resting" | "bounded" | "failed"
  readonly steps: number
  readonly example: ActorCase<M>
  readonly failure?: { readonly kind: "invariant" | "execution"; readonly invariant?: string; readonly cause: unknown }
}
export interface ActorCheckReport {
  readonly status: "passed" | "bounded"
  readonly seed: number
  readonly numRuns: number
  readonly boundedRuns: number
  readonly policy: Readonly<Record<keyof typeof DEFAULT_ACTOR_CHECK, number>>
}

export class ActorCheckError<M extends ActorMethods = ActorMethods> extends Error {
  constructor(
    readonly counterexample: ActorCaseResult<M>,
    readonly seed: number,
    readonly numShrinks: number,
  ) {
    super(`Actor check failed: ${counterexample.failure?.invariant ?? "execution"} (seed ${seed}, ${numShrinks} shrinks)`, { cause: counterexample.failure?.cause })
    this.name = "ActorCheckError"
  }
}

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}
const policyOf = (options: ActorCheckPolicy) => ({
  maxSteps: positive("maxSteps", options.maxSteps ?? DEFAULT_ACTOR_CHECK.maxSteps),
  timeoutMs: positive("timeoutMs", options.timeoutMs ?? DEFAULT_ACTOR_CHECK.timeoutMs),
})

const execute = async <R, M extends ActorMethods>(
  actor: Actor<R, M>,
  input: ActorCheckInput<M>,
  generate: ActorCheckContext["generate"],
  options: ActorCaseOptions<R>,
): Promise<ActorCaseResult<M>> => {
  const policy = policyOf(options)
  const recordedEvents: Event[] = []
  const choices: unknown[] = []
  const keys = new Set<string>()
  const runtime = actorRuntimeOf(actor)
  let steps = 0
  let bounded = false
  let failedPrefix: ReadonlyArray<Event> | undefined
  let failure: ActorCaseResult<M>["failure"]
  const stop = new Error("Actor check stopped")
  const inspect = (events: ReadonlyArray<Event>) => {
    for (const [name, invariant] of Object.entries(options.invariants)) {
      try {
        const result = invariant({ events: structuredClone(events) })
        if (result === false) throw new Error(`Invariant ${name} returned false`)
        if (result !== undefined && typeof result !== "boolean") throw new Error("Invariants must return synchronously")
      } catch (cause) {
        failure = { kind: "invariant", invariant: name, cause }
        failedPrefix = structuredClone(events)
        throw stop
      }
    }
  }
  const log = withWatermark({
    read: Effect.sync(() => [...recordedEvents]),
    append: (events) => Effect.sync(() => {
      if (failure !== undefined || bounded) throw stop
      const fresh = events.filter(event => {
        const key = runtime.keyOf(event)
        if (key === undefined) return true
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
      if (fresh.length === 0) return
      if (steps === policy.maxSteps) {
        bounded = true
        throw stop
      }
      const start = recordedEvents.length
      recordedEvents.push(...structuredClone(fresh))
      steps++
      for (let end = start + 1; end <= recordedEvents.length; end++) inspect(recordedEvents.slice(0, end))
    }),
  })
  const unsupported = (operation: string) => Effect.sync(() => {
    const cause = new Error(`Actor checking does not support ${operation}`)
    failure ??= { kind: "execution", cause }
    throw cause
  })
  const layers = Layer.mergeAll(
    Layer.succeed(EventLog, log),
    Layer.succeed(Self, parseThreadAddress(`${actor.name}:check:root`)),
    Layer.succeed(Router, { send: () => unsupported("cross-thread delivery") }),
    Layer.succeed(ThreadAllocator, { allocate: () => unsupported("child allocation") }),
  )
  try {
    inspect([])
    const context: ActorCheckContext = {
      generate: (arbitrary, ...args) => {
        if (failure !== undefined || bounded) throw stop
        try {
          const value = structuredClone(generate(arbitrary, ...args))
          choices.push(structuredClone(value))
          return value
        } catch (cause) {
          failure ??= { kind: "execution", cause }
          throw cause
        }
      },
    }
    const services = options.services?.(context) ?? Layer.empty
    // layers supplies the runtime ports excluded by Services<R>; the caller supplies the remaining requirements.
    const environment = Layer.merge(layers, services) as Layer.Layer<R | EventLog>
    await Effect.runPromise(Effect.gen(function* () {
      const method = actor.methods[input.method]
      if (method === undefined) return yield* Effect.die(new Error(`Unknown actor method ${input.method}`))
      yield* log.append([method.eventOf({ invocation: { method: input.method, id: "check", epoch: 0 }, input: structuredClone(input.input), at: 0 })])
      yield* createActorReconciler(actor).settle
    }).pipe(Effect.provide(environment), Effect.timeout(policy.timeoutMs)))
  } catch (cause) {
    if (!bounded && failure === undefined) failure = { kind: "execution", cause }
  }
  return {
    status: failure !== undefined ? "failed" : bounded ? "bounded" : "resting",
    steps,
    events: failedPrefix ?? recordedEvents,
    example: { input: structuredClone(input), choices, policy },
    ...(failure === undefined ? {} : { failure }),
  }
}

// replayActor executes recorded inputs and generated service values with fresh services (check.test.ts).
export const replayActor = async <R, M extends ActorMethods>(
  actor: Actor<R, M>, example: ActorCase<M>, options: ActorCaseOptions<R>,
): Promise<ActorCaseResult<M>> => {
  let index = 0
  const result = await execute(actor, example.input, <T, Args extends unknown[]>(_arbitrary: (...args: Args) => fc.Arbitrary<T>, ..._args: Args): T => {
    if (index >= example.choices.length) throw new Error("Replay exhausted its recorded service values")
    return structuredClone(example.choices[index++]) as T
  }, { ...example.policy, ...options })
  if (result.status === "resting" && index !== example.choices.length) {
    return { ...result, status: "failed", failure: { kind: "execution", cause: new Error("Replay left unused service values") } }
  }
  return result
}

// checkActor samples method inputs and generated service values, shrinking failures through fresh executions (check.test.ts).
export const checkActor = async <R, M extends ActorMethods>(
  actor: Actor<R, M>, options: ActorCheckOptions<R, M>,
): Promise<ActorCheckReport> => {
  const policy = { ...policyOf(options), numRuns: positive("numRuns", options.numRuns ?? DEFAULT_ACTOR_CHECK.numRuns) }
  if (Object.keys(options.invariants).length === 0) throw new Error("Provide at least one invariant")
  let boundedRuns = 0
  let failureIdentity: string | undefined
  const property = fc.asyncProperty(options.inputs, fc.gen(), async (input, generate) => {
    const result = await execute(actor, input, generate, options)
    if (result.status === "failed") {
      const identity = result.failure?.kind === "invariant" ? `invariant:${result.failure.invariant}` : "execution"
      failureIdentity ??= identity
      fc.pre(identity === failureIdentity)
      throw new ActorCheckError(result, 0, 0)
    }
    if (result.status === "bounded") boundedRuns++
  })
  const checked = await fc.check(property, { numRuns: policy.numRuns, ...(options.seed === undefined ? {} : { seed: options.seed }) })
  if (checked.failed) {
    if (checked.errorInstance instanceof ActorCheckError) {
      throw new ActorCheckError(checked.errorInstance.counterexample, checked.seed, checked.numShrinks)
    }
    throw checked.errorInstance ?? new Error("Actor check could not complete")
  }
  return { status: boundedRuns > 0 ? "bounded" : "passed", seed: checked.seed, numRuns: checked.numRuns, boundedRuns, policy }
}
