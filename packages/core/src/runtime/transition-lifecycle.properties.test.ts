import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc, { type AsyncCommand } from "fast-check"
import { component, transitionProjectionOf, type TransitionContext } from "../component"
import type { Event } from "../event"
import { EventLog, withWatermark } from "../log"
import { createActorReconciler, enabled } from "./reconciler"

type Stage = "download" | "upload"
type Ownership = "request" | "completion"
type Crash = "before-effect" | "after-effect" | "after-commit"
interface Operation { readonly request: number; readonly stage: Stage; readonly revision: number }
const operationId = ({ request, stage }: Pick<Operation, "request" | "stage">): string => `${request}/${stage}`

interface Model {
  readonly requests: Map<number, number>
  readonly completed: Set<string>
  readonly references: Map<string, string>
}

const eligible = (model: Model): Operation[] => [...model.requests].flatMap(([request, revision]) => {
  const stage = !model.completed.has(`${request}/download`) ? "download" : "upload"
  return model.completed.has(`${request}/${stage}`) ? [] : [{ request, stage, revision }]
})

const harness = (ownership: Ownership, reuseTag: boolean) => {
  const events: Event[] = []
  const attempts: Operation[] = []
  const performed: Operation[] = []
  let crash: Crash = "before-effect"
  const stop = () => { throw new Error("simulated crash") }
  const tag = (stage: Stage) => ownership === "completion" || reuseTag ? "run" : stage
  const actor = () => {
    interface Pending extends Operation { readonly ctx: TransitionContext }
    const worker = component({
      name: "files",
      initial: (): ReadonlyArray<Pending> => [],
      step: (state, event, ctx) => {
        if (event.type === "Requested") return [...state, { request: event.request as number, revision: 0, stage: "download" as const, ctx }]
        if (event.type === "Revised") return state.map((pending) => pending.request === event.request
          ? { ...pending, revision: pending.revision + 1 } : pending).reverse()
        return state.flatMap((pending): Pending[] => {
          if (!pending.ctx.matches(tag(pending.stage), event)) return [pending]
          return pending.stage === "upload" ? [] : [{
            ...pending, stage: "upload", ctx: ownership === "completion" ? ctx : pending.ctx
          }]
        })
      },
      output: (state) => ({
        view: undefined,
        transitions: state.map(({ ctx, ...input }) => ctx.effect(tag(input.stage), {
          input,
          act: (operation) => Effect.sync(() => {
            attempts.push(operation)
            if (crash === "before-effect") stop()
            performed.push(operation)
            if (crash === "after-effect") stop()
            return { type: "Completed", ...operation, callId: "7" }
          })
        }))
      })
    })
    return { projections: [transitionProjectionOf(worker)], keyOf: () => undefined }
  }
  let runtime = actor()
  let reconciler = createActorReconciler(runtime)
  const log = Layer.succeed(EventLog, withWatermark({
    read: Effect.sync(() => [...events]),
    append: (tail) => Effect.sync(() => {
      events.push(...tail)
      stop()
    })
  }))
  return {
    events, attempts, performed,
    transitions: () => enabled(runtime, events),
    attempt: async (point: Crash) => {
      crash = point
      await expect(Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))).rejects.toThrow("simulated crash")
    },
    restart: () => {
      const replayed: Event[] = JSON.parse(JSON.stringify(events))
      events.splice(0, events.length, ...replayed)
      runtime = actor()
      reconciler = createActorReconciler(runtime)
    },
    settleCompleted: () => Effect.runPromise(reconciler.settle.pipe(Effect.provide(log)))
  }
}
type Harness = ReturnType<typeof harness>

// assertRefinement compares runtime offers with logical operations identified independently of refs (tla/runtime/TransitionDeclarations.tla, UniqueRefs).
const assertRefinement = (model: Model, real: Harness): void => {
  const transitions = real.transitions()
  const actual = transitions.map((transition) => operationId(transition.input as Operation)).sort()
  const expected = eligible(model).map(operationId).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("enabled operations disagree with logical operations")
  for (const transition of transitions) {
    const input = transition.input as Operation
    const id = operationId(input)
    expect(input.revision).toBe(model.requests.get(input.request)!)
    const prior = model.references.get(id)
    if (prior !== undefined) expect(transition.key).toBe(prior)
    for (const [other, key] of model.references) {
      if (other !== id) expect(transition.key).not.toBe(key)
    }
    model.references.set(id, transition.key)
  }
}

const request = (noise: number): AsyncCommand<Model, Harness> => ({
  check: () => true,
  run: async (model, real) => {
    const id = model.requests.size
    real.events.push(...Array.from({ length: noise }, () => ({ type: "Noise" })))
    real.events.push({ type: "Requested", request: id, callId: "7" })
    model.requests.set(id, 0)
    assertRefinement(model, real)
  },
  toString: () => `request(noise=${noise})`
})

const revise = (choice: number): AsyncCommand<Model, Harness> => ({
  check: (model) => eligible(model).length > 0,
  run: async (model, real) => {
    const pending = eligible(model)
    const selected = pending[choice % pending.length]!
    real.events.push({ type: "Revised", request: selected.request })
    model.requests.set(selected.request, selected.revision + 1)
    assertRefinement(model, real)
  },
  toString: () => `revise(${choice})`
})

const attempt = (point: Crash): AsyncCommand<Model, Harness> => ({
  check: (model) => eligible(model).length > 0,
  run: async (model, real) => {
    const offered = eligible(model)
    const before = { attempts: real.attempts.length, performed: real.performed.length, events: real.events.length }
    await real.attempt(point)
    expect(real.attempts).toHaveLength(before.attempts + 1)
    const operation = real.attempts.at(-1)!
    expect(offered).toContainEqual(operation)
    expect(real.performed).toHaveLength(before.performed + (point === "before-effect" ? 0 : 1))
    expect(real.events).toHaveLength(before.events + (point === "after-commit" ? 1 : 0))
    if (point === "after-commit") {
      const id = operationId(operation)
      expect(model.completed.has(id)).toBe(false)
      const key = model.references.get(id)!
      const [seq, component, tag] = JSON.parse(key) as [number, string, string]
      expect(real.events.at(-1)).toEqual({ type: "Completed", ...operation, callId: "7", transitionRef: { seq, component, tag } })
      model.completed.add(id)
    }
    assertRefinement(model, real)
  },
  toString: () => `attempt(${point})`
})

const restart = (): AsyncCommand<Model, Harness> => ({
  check: () => true,
  run: async (model, real) => {
    real.restart()
    assertRefinement(model, real)
  },
  toString: () => "restart()"
})

const commands = fc.commands([
  fc.integer({ min: 0, max: 2 }).map(request),
  fc.nat({ max: 10 }).map(revise),
  fc.constantFrom<Crash>("before-effect", "after-effect", "after-commit").map(attempt),
  fc.constant(null).map(restart)
], { maxCommands: 20 })

const lifecycle = async (ownership: Ownership, trace: Iterable<AsyncCommand<Model, Harness>>, reuseTag = false): Promise<void> => {
  const model: Model = { requests: new Map(), completed: new Set(), references: new Map() }
  const real = harness(ownership, reuseTag)
  await request(1).run(model, real)
  await request(0).run(model, real)
  await attempt("before-effect").run(model, real)
  await revise(0).run(model, real)
  await attempt("after-effect").run(model, real)
  await restart().run(model, real)
  await fc.asyncModelRun(() => ({ model, real }), trace)
  while (eligible(model).length > 0) await attempt("after-commit").run(model, real)
  const before = { events: [...real.events], attempts: [...real.attempts], performed: [...real.performed] }
  await real.settleCompleted()
  real.restart()
  await real.settleCompleted()
  expect(real.events).toEqual(before.events)
  expect(real.attempts).toEqual(before.attempts)
  expect(real.performed).toEqual(before.performed)
}

test("logical operations preserve refs through changing outputs, retries, completion, and cold replay", async () => {
  await fc.assert(fc.asyncProperty(commands, async (trace) => {
    await lifecycle("request", trace)
    await lifecycle("completion", trace)
  }), { numRuns: 100 })
})

test("sequential tag reuse is a counterexample to logical operation correlation", async () => {
  const result = await fc.check(fc.asyncProperty(commands, (trace) => lifecycle("request", trace, true)), { numRuns: 10 })
  expect(result.failed).toBe(true)
  expect(String(result.errorInstance)).toContain("enabled operations disagree with logical operations")
})
