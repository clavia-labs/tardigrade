import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { act, defineActor, durableAtom, durablePromise, effectAtom, effectKey, EffectExecution, PromiseNotReady, RuntimeError, type ActorRuntime, type Journal, type PromiseSettled, type Recorded } from "@clavia/tardigrade-experimental-core"
import { createActorStore } from "../../../../core/src/runtime/execution"
import { Promises } from "../../../../core/src/services/promises"

const Started = Schema.Struct({ type: Schema.Literal("Started") })
const Value = Schema.Union([Schema.Finite, Schema.String])
const Returned = Schema.Struct({ type: Schema.Literal("Returned"), value: Value })
const Marker = Schema.Struct({ type: Schema.Literal("Marker"), name: Schema.String })
const Event = Schema.Union([Started, Returned, Marker])
type Event = typeof Event.Type
const State = Schema.Struct({ started: Schema.Boolean, results: Schema.Array(Value), markers: Schema.Array(Schema.String) })
const Job = act({ name: "test.promise-delivery", input: Schema.Struct({}), success: Schema.Finite, failure: Schema.String })

interface DeliveryCase {
  readonly value: number
  readonly rejected: boolean
  readonly duplicates: number
  readonly updates: number
  readonly holdMillis: number
}

// runPromiseDeliveryScenario checks delivery ordering while the effect settlement commit is held open.
const runPromiseDeliveryScenario = (mode: "local" | "external", options: DeliveryCase) => Effect.runPromise(Effect.gen(function* () {
  const executionReady = yield* Deferred.make<void, RuntimeError>()
  const allowSettlement = yield* Deferred.make<void>()
  const commitEntered = yield* Deferred.make<void>()
  const allowCommit = yield* Deferred.make<void>()
  const markerCommitted = yield* Deferred.make<void>()
  const records: Recorded<Event>[] = []
  const payloads = () => records.map(record => record.event)
  let runtime!: ActorRuntime<Event>
  let earlyResult!: PromiseSettled
  let externalAcknowledged = false
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]),
    readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires undefined; Effect.void has a void result type.
    readCheckpoint: Effect.succeed(undefined),
    append: (expected, events) => Effect.gen(function* () {
      if (events.some(({ event }) => event.type === "EffectSettled")) {
        yield* Deferred.succeed(commitEntered, undefined)
        yield* Deferred.await(allowCommit)
      }
      if (expected !== records.length) return yield* Effect.fail(new RuntimeError("Unexpected journal length"))
      records.push(...events)
      if (events.some(({ event }) => event.type === "Marker" && event.name === "before")) yield* Deferred.succeed(markerCommitted, undefined)
    }),
    appendWithCheckpoint: () => Effect.fail(new RuntimeError("Unexpected checkpoint")),
  }
  const actor = defineActor("delivery", Effect.sync(() => {
    const state = durableAtom({ name: "test.delivery", input: Event, schema: State,
      initial: { started: false, results: [], markers: [] },
      reduce: (state, event) => event.type === "Started" ? { ...state, started: true }
        : event.type === "Returned" ? { ...state, results: [...state.results, event.value] }
        : { ...state, markers: [...state.markers, event.name] },
    })
    const request = Job.request({ tag: "job", input: {}, onSettled: result => [{ type: "Returned", value: result.status === "fulfilled" ? result.value : "rejected" }] })
    return {
      atom: Object.assign(effectAtom(get => {
        const view = get(state)
        return { view, events: {}, acts: view.started && view.results.length === 0 ? { job: request } : {} }
      }), { schema: Event }),
      actions: { start: () => ({ type: "Started" as const }) },
    }
  }))
  const store = yield* createActorStore({ actor, journal, checkpoint: { mode: "manual" }, promiseDelivery: { retryIntervalMs: 2 },
    actorContext: () => Context.empty(),
    services: host => {
      runtime = host
      return Layer.merge(Job.layer(() => Effect.gen(function* () {
        const execution = yield* EffectExecution
        const promise = durablePromise(execution.ref, { success: Schema.Finite, error: Schema.String })
        earlyResult = options.rejected ? promise.fail("rejected") : promise.succeed(options.value)
        const early = yield* execution.record(earlyResult).pipe(Effect.result)
        if (early._tag !== "Failure" || !(early.failure instanceof PromiseNotReady)) {
          const error = new RuntimeError("Early settlement was not rejected as retryable")
          yield* Deferred.fail(executionReady, error)
          return yield* Effect.fail(error.message)
        }
        const handle = mode === "local" ? yield* execution.fork(Effect.succeed(earlyResult)) : { executor: "remote", id: "job", mode: "push" as const }
        yield* Deferred.succeed(executionReady, undefined)
        yield* Deferred.await(allowSettlement)
        return Job.defer(handle)
      }).pipe(Effect.mapError(String))), Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }))
    },
  })
  return yield* Effect.gen(function* () {
    yield* store.actions.start()
    yield* Deferred.await(executionReady)
    if (mode === "external") {
      yield* runtime.send([{ type: "Marker", name: "before" }, earlyResult, { type: "Marker", name: "after" }]).pipe(
        Effect.andThen(Effect.sync(() => { externalAcknowledged = true })), Effect.forkScoped,
      )
      yield* Deferred.await(markerCommitted)
    }
    for (let index = 0; index < options.updates; index++) yield* runtime.send([{ type: "Marker", name: `noise:${index}` }])
    yield* Effect.sleep(options.holdMillis)
    if (payloads().some(event => event.type === "PromiseSettled" || event.type === "Returned") || externalAcknowledged) return yield* Effect.fail(new RuntimeError("Result accepted before effect settlement"))
    yield* Deferred.succeed(allowSettlement, undefined)
    yield* Deferred.await(commitEntered)
    yield* Effect.sleep(options.holdMillis)
    if (payloads().some(event => event.type === "PromiseSettled" || event.type === "Returned") || store.getState().view.results.length !== 0 || externalAcknowledged) return yield* Effect.fail(new RuntimeError("Result accepted before durable commit"))
    yield* Deferred.succeed(allowCommit, undefined)
    yield* store.wait
    if (mode === "external") {
      while (!externalAcknowledged) yield* Effect.sleep(2)
      yield* store.wait
    }
    for (let index = 0; index < options.duplicates; index++) yield* runtime.send([earlyResult])
    yield* store.wait
    const state = store.getState().view
    const types = payloads().map(event => event.type)
    if (types.filter(type => type === "PromiseSettled").length !== 1 || types.filter(type => type === "Returned").length !== 1 || state.results.length !== 1 || state.results[0] !== (options.rejected ? "rejected" : options.value)) return yield* Effect.fail(new RuntimeError("Settlement or callback duplicated"))
    const markers = state.markers.filter(name => !name.startsWith("noise:"))
    if (mode === "external" && markers.join(",") !== "before,after") return yield* Effect.fail(new RuntimeError("Delivery retry repeated committed batch events"))
    for (const [index, event] of payloads().entries()) {
      if (event.type !== "PromiseSettled") continue
      const preceding = payloads().slice(0, index).find(record => record.type === "EffectSettled" && effectKey(record.ref) === effectKey(event.ref))
      if (preceding?.type !== "EffectSettled" || preceding.outcome.status !== "fulfilled") return yield* Effect.fail(new RuntimeError("Promise settlement requires a preceding successful effect settlement"))
    }
  }).pipe(Effect.ensuring(Deferred.succeed(allowSettlement, undefined).pipe(
    Effect.andThen(Deferred.succeed(allowCommit, undefined)), Effect.andThen(store.close),
  )))
}).pipe(Effect.scoped, Effect.timeout(5_000)))

// promiseSettlementOrder checks successful effect settlement precedes eventual result delivery.
export const promiseSettlementOrder = fc.asyncProperty(fc.record({
  mode: fc.constantFrom("local" as const, "external" as const),
  value: fc.integer({ min: -100, max: 100 }), rejected: fc.boolean(),
  duplicates: fc.integer({ min: 0, max: 4 }), updates: fc.integer({ min: 0, max: 4 }),
  holdMillis: fc.integer({ min: 1, max: 5 }),
}), ({ mode, ...options }) => runPromiseDeliveryScenario(mode, options))
