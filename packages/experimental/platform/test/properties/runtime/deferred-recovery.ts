import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { act, defineActor, durableAtom, durablePromise, effectAtom, effectKey, EffectExecution, ExecutionHandle, EffectRef as EffectRefSchema, RuntimeError, type ActorRuntime, type EffectRef, type Journal, type Recorded } from "@clavia/tardigrade-experimental-core"
import { createActorStore } from "../../../../core/src/runtime/execution"
import { Promises } from "../../../../core/src/services/promises"

const Queued = Schema.Struct({ type: Schema.Literal("Queued") })
const Running = Schema.Struct({ type: Schema.Literal("Running") })
const Submitted = Schema.Struct({ type: Schema.Literal("Submitted"), ref: EffectRefSchema, handle: ExecutionHandle })
const Updated = Schema.Struct({ type: Schema.Literal("Updated") })
const Result = Schema.Union([Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.Finite }), Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.String })])
const Returned = Schema.Struct({ type: Schema.Literal("Returned"), result: Result })
const Event = Schema.Union([Queued, Running, Submitted, Updated, Returned])
type Event = typeof Event.Type
const State = Schema.Struct({ queued: Schema.Boolean, running: Schema.Boolean, updates: Schema.Finite, submissions: Schema.Array(Submitted), results: Schema.Array(Result) })
const Job = act({ name: "test.deferred-recovery", input: Schema.Struct({ value: Schema.Finite }), success: Schema.Finite, failure: Schema.String })

interface RecoveryCase {
  readonly value: number
  readonly completion: "forked" | "immediate" | "rejected"
  readonly updates: number
  readonly extraReopens: number
}

const runRecoveryScenario = (executor: "local" | "remote", options: RecoveryCase) => Effect.runPromise(Effect.gen(function* () {
  const recorded = yield* Deferred.make<void>()
  const blocked = yield* Deferred.make<void>()
  const records: Recorded<Event>[] = []
  const payloads = () => records.map(record => record.event)
  const executions: EffectRef[] = []
  let reopening = false
  let watches = 0
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires undefined; Effect.void has a void result type.
    readCheckpoint: Effect.succeed(undefined),
    append: (expected, events) => Effect.gen(function* () {
      if (expected !== records.length) return yield* Effect.fail(new RuntimeError("Unexpected journal length"))
      const settling = events.some(({ event }) => event.type === "EffectSettled")
      if (settling && !events.some(({ event }) => event.type === "Submitted")) return yield* Effect.fail(new RuntimeError("Deferred notification was not committed with settlement"))
      records.push(...events)
      if (settling) yield* Deferred.succeed(recorded, undefined)
    }),
    appendWithCheckpoint: () => Effect.fail(new RuntimeError("Unexpected checkpoint")),
  }
  const actor = defineActor("recovery", Effect.sync(() => {
    const state = durableAtom({ name: "test.deferred-recovery", input: Event, schema: State,
      initial: { queued: false, running: false, updates: 0, submissions: [], results: [] },
      reduce: (state, event) => event.type === "Queued" ? { ...state, queued: true }
        : event.type === "Running" ? { ...state, running: true }
        : event.type === "Submitted" ? { ...state, submissions: [...state.submissions, event] }
        : event.type === "Updated" ? { ...state, updates: state.updates + 1 }
        : { ...state, queued: false, running: false, results: [...state.results, event.result] },
    })
    const request = Job.request({ tag: "job", input: { value: options.value }, onRequested: () => [{ type: "Running" }],
      onDeferred: (handle, ref) => [{ type: "Submitted", ref, handle }],
      onSettled: result => [{ type: "Returned", result: result.status === "rejected" ? { ...result, reason: typeof result.reason === "string" ? result.reason : JSON.stringify(result.reason) } : result }],
    })
    return { atom: Object.assign(effectAtom(get => {
      const view = get(state)
      return { view, events: {}, acts: view.queued && !view.running ? { job: request } : {} }
    }), { schema: Event }), actions: { start: () => ({ type: "Queued" as const }), update: () => ({ type: "Updated" as const }) } }
  }))
  const open = () => createActorStore({ actor, journal, checkpoint: { mode: "manual" }, promiseDelivery: { retryIntervalMs: 1 }, actorContext: () => Context.empty(),
    services: (host: ActorRuntime<Event>) => Layer.merge(Job.layer(input => Effect.gen(function* () {
      const execution = yield* EffectExecution
      executions.push(execution.ref)
      if (executor === "remote") return Job.defer({ executor: "remote", id: "job" })
      if (reopening && options.completion === "rejected") return yield* Effect.fail("Recovered operation failed")
      if (reopening && options.completion === "immediate") return input.value
      const promise = durablePromise(execution.ref, { success: Schema.Finite, error: Schema.String })
      const operation = (reopening ? Effect.void : Deferred.await(blocked)).pipe(Effect.as(promise.succeed(input.value)))
      return Job.defer(yield* execution.fork(operation))
    }).pipe(Effect.mapError(String))), Layer.succeed(Promises, {
      watch: registration => Effect.gen(function* () {
        watches++
        if (executor === "local") return yield* Effect.fail(new RuntimeError("Local producer delegated to external resolver"))
        if (!reopening) return
        const promise = durablePromise(registration.ref, { success: Schema.Finite, error: Schema.String })
        yield* host.send([options.completion === "rejected" ? promise.fail("Recovered operation failed") : promise.succeed(options.value)])
      }), cancel: () => Effect.void,
    })),
  })
  const first = yield* open()
  yield* Effect.gen(function* () {
    yield* first.actions.start()
    yield* Deferred.await(recorded)
    yield* first.actions.update()
    const submissions = first.getState().view.submissions
    if (submissions.length !== 1 || first.getState().view.results.length !== 0 || payloads().some(event => event.type === "PromiseSettled")) return yield* Effect.fail(new RuntimeError("Deferred handle was not delivered before completion"))
    if (submissions[0]!.handle.executor !== executor || effectKey(submissions[0]!.ref) !== effectKey(executions[0]!)) return yield* Effect.fail(new RuntimeError("Deferred notification changed its handle or reference"))
    const settledIndex = payloads().findIndex(event => event.type === "EffectSettled")
    if (records[settledIndex + 1]?.event.type !== "Submitted") return yield* Effect.fail(new RuntimeError("Deferred notification was not committed with settlement"))
    for (let index = 0; index < options.updates; index++) yield* first.actions.update()
  }).pipe(Effect.ensuring(first.close))
  reopening = true
  for (let cycle = 0; cycle <= options.extraReopens; cycle++) {
    const restored = yield* open()
    yield* Effect.gen(function* () {
      yield* restored.wait
      const expectedExecutions = executor === "local" ? 2 : 1
      const results = restored.getState().view.results
      const settlements = payloads().filter(event => event.type === "PromiseSettled")
      const requests = payloads().filter(event => event.type === "EffectRequested")
      if (executions.length !== expectedExecutions || results.length !== 1 || restored.getState().view.submissions.length !== 1 || settlements.length !== 1 || requests.length !== 1 || payloads().filter(event => event.type === "EffectSettled").length !== 1 || payloads().filter(event => event.type === "Running").length !== 1) return yield* Effect.fail(new RuntimeError("Deferred recovery did not resume exactly once"))
      if (requests[0]!.type !== "EffectRequested" || settlements[0]!.type !== "PromiseSettled" || executions.some(ref => effectKey(ref) !== effectKey(requests[0]!.ref)) || effectKey(settlements[0]!.ref) !== effectKey(requests[0]!.ref)) return yield* Effect.fail(new RuntimeError("Deferred recovery changed the accepted reference"))
      const result = results[0]!
      if (options.completion === "rejected" ? result.status !== "rejected" || result.reason !== "Recovered operation failed" : result.status !== "fulfilled" || result.value !== options.value) return yield* Effect.fail(new RuntimeError("Deferred recovery changed the result"))
      if (executor === "local" ? watches !== 0 : watches === 0) return yield* Effect.fail(new RuntimeError("Recovery used the wrong executor"))
    }).pipe(Effect.ensuring(restored.close))
  }
}).pipe(Effect.scoped, Effect.timeout(5_000)))

const recoveryCases = fc.record({ value: fc.integer({ min: -100, max: 100 }), completion: fc.constantFrom("forked" as const, "immediate" as const, "rejected" as const), updates: fc.integer({ min: 0, max: 3 }), extraReopens: fc.integer({ min: 0, max: 2 }) })

// ownedProducerRecovery checks lost local producers restart with their accepted reference and settle once.
export const ownedProducerRecovery = fc.asyncProperty(recoveryCases, options => runRecoveryScenario("local", options))
// externalProducerObservation checks external handles resume observation without repeating their accepted execution.
export const externalProducerObservation = fc.asyncProperty(recoveryCases, options => runRecoveryScenario("remote", options))
