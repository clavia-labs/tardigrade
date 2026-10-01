import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { act, defineActor, durableAtom, durablePromise, effectAtom, effectKey, EffectExecution, RuntimeError, type ActorRuntime, type EffectRef, type Journal, type Recorded, type RuntimeEvent, type StoredCheckpoint } from "@clavia/tardigrade-experimental-core"
import { createActorStore } from "../../../../core/src/runtime/execution"
import { Promises } from "../../../../core/src/services/promises"

const Started = Schema.Struct({ type: Schema.Literal("Started") })
const Returned = Schema.Struct({ type: Schema.Literal("Returned") })
const Event = Schema.Union([Started, Returned])
type Event = typeof Event.Type
const Job = act({ name: "test.cancellation", input: Schema.Finite, success: Schema.Finite, failure: Schema.String })
const actor = (id: number) => defineActor("cancellation", Effect.sync(() => {
  const started = durableAtom({ name: "test.cancellation", input: Event, schema: Schema.Boolean, initial: false, reduce: (state, event) => state || event.type === "Started" })
  const request = Job.request({ tag: "job", input: id, onSettled: () => [{ type: "Returned" }] })
  return { atom: Object.assign(effectAtom(get => ({ view: get(request.result), events: {}, acts: get(started) ? { job: request } : {} })), { schema: Event }), actions: { start: () => ({ type: "Started" as const }) } }
}))

interface CancellationCase {
  readonly mode: "inline" | "local" | "remote" | "submitting"
  readonly completionFirst: boolean
  readonly rejected: boolean
  readonly value: number
  readonly reason: string
  readonly duplicates: number
  readonly reopens: number
  readonly checkpoint: boolean
}

const runCancellationScenario = (options: CancellationCase) => Effect.runPromise(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const settled = yield* Deferred.make<void>()
  const records: Recorded<Event>[] = []
  const payloads = () => records.map(record => record.event)
  let saved: StoredCheckpoint | undefined
  let runtime!: ActorRuntime<Event>
  let reference!: EffectRef
  let signal!: AbortSignal
  let executions = 0
  let cleanups = 0
  let cleanedHandle = false
  let abortedBeforeCommit = false
  const append = (position: number, events: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint) => Effect.gen(function* () {
    if (position !== records.length) return yield* Effect.fail(new RuntimeError("Unexpected journal position"))
    records.push(...events)
    if (checkpoint) saved = checkpoint
    if (events.some(({ event }) => event.type === "EffectSettled")) yield* Deferred.succeed(settled, undefined)
  })
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    readCheckpoint: Effect.sync(() => saved), append, appendWithCheckpoint: append,
  }
  const result = () => {
    const promise = durablePromise(reference, { success: Schema.Finite, error: Schema.String })
    return options.rejected ? promise.fail("failed") : promise.succeed(options.value)
  }
  const open = () => createActorStore({ actor: actor(0), journal, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(),
    services: host => {
      runtime = host
      return Layer.merge(Job.layer((_input, context) => Effect.gen(function* () {
        executions++
        reference = context.ref
        signal = context.signal
        signal.addEventListener("abort", () => {
          if (!options.completionFirst && !payloads().some(event => event.type === "EffectCancelled")) abortedBeforeCommit = true
        }, { once: true })
        const execution = yield* EffectExecution
        if (options.mode === "submitting") return Job.defer(yield* execution.submit(Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return { executor: "remote", id: "job" }
        })))
        yield* Deferred.succeed(entered, undefined)
        if (options.mode === "remote") return Job.defer({ executor: "remote", id: "job" })
        if (options.mode === "local") return Job.defer(yield* execution.fork(Deferred.await(release).pipe(Effect.map(result))))
        yield* Deferred.await(release)
        if (options.rejected) return yield* Effect.fail("failed")
        return options.value
      }).pipe(Effect.mapError(String)), { cancel: (_input, { handle }) => Effect.sync(() => {
        cleanups++
        if (handle) cleanedHandle = true
      }) }), Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }))
    },
  })
  const first = yield* open()
  yield* Effect.gen(function* () {
    yield* first.actions.start()
    yield* Deferred.await(entered)
    if (options.mode === "remote" || options.mode === "local") yield* Deferred.await(settled)
    if (options.completionFirst) {
      yield* Deferred.succeed(release, undefined)
      if (options.mode === "remote" || options.mode === "submitting") {
        yield* Deferred.await(settled)
        yield* runtime.send([result()])
      }
      yield* first.wait
    }
    yield* first.cancel(reference, options.reason)
    yield* Deferred.succeed(release, undefined)
    yield* first.wait
    for (let index = 0; index <= options.duplicates; index++) {
      yield* first.cancel(reference, "duplicate")
      if (!options.completionFirst) yield* runtime.deliver(reference, [result(), { type: "Returned" }])
      else if (options.mode !== "inline") yield* runtime.send([result()])
    }
    yield* first.wait
    if (abortedBeforeCommit || (!options.completionFirst && (!signal.aborted || cleanups === 0))) return yield* Effect.fail(new RuntimeError("Cancellation must commit before abort and cleanup"))
    if (!options.completionFirst && options.mode !== "inline" && !cleanedHandle) return yield* Effect.fail(new RuntimeError("Cancellation lost the deferred handle"))
    if (options.mode === "submitting" && !options.completionFirst) {
      if (payloads().findIndex(event => event.type === "EffectCancelled") >= payloads().findIndex(event => event.type === "EffectSettled")) return yield* Effect.fail(new RuntimeError("Submission race did not preserve its late handle"))
    }
    if (options.checkpoint) yield* first.checkpoint
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.andThen(first.close))))
  for (let cycle = 0; cycle < options.reopens; cycle++) {
    const restored = yield* open()
    yield* Effect.gen(function* () {
      yield* restored.wait
      yield* restored.cancel(reference, "reopened")
      if (!options.completionFirst) yield* runtime.deliver(reference, [result(), { type: "Returned" }])
      yield* restored.wait
      const state = restored.getState().view
      if (!options.completionFirst && (state.status !== "rejected" || !Schema.is(Schema.TaggedStruct("Cancelled", { reason: Schema.Literal(options.reason) }))(state.reason))) return yield* Effect.fail(new RuntimeError("Recovery lost the durable cancellation outcome"))
    }).pipe(Effect.ensuring(restored.close))
  }
  const cancelled = payloads().filter(event => event.type === "EffectCancelled")
  const completed = payloads().filter(event => event.type === "PromiseSettled" || (event.type === "EffectSettled" && options.mode === "inline"))
  const delivered = payloads().filter(event => event.type === "Returned")
  if (executions !== 1 || payloads().filter(event => event.type === "EffectRequested").length !== 1 || cancelled.length !== (options.completionFirst ? 0 : 1) || completed.length !== (options.completionFirst ? 1 : 0) || delivered.length !== 1) return yield* Effect.fail(new RuntimeError("Terminal decision changed or terminal callback duplicated"))
  if (payloads().some(event => "ref" in event && effectKey(event.ref) !== effectKey(reference))) return yield* Effect.fail(new RuntimeError("Recovery changed the accepted reference"))
}).pipe(Effect.scoped, Effect.timeout(5_000)))

// cancellationTerminality checks terminalExclusive and submissionPreserved (core/quint/cancellation.qnt), and deliverySound and callbackAtMostOnce (core/quint/terminalDelivery.qnt).
export const cancellationTerminality = fc.asyncProperty(fc.record({
  mode: fc.constantFrom("inline" as const, "local" as const, "remote" as const, "submitting" as const), completionFirst: fc.boolean(), rejected: fc.boolean(),
  value: fc.integer({ min: -100, max: 100 }), reason: fc.string({ maxLength: 20 }), duplicates: fc.integer({ min: 0, max: 3 }), reopens: fc.integer({ min: 0, max: 2 }), checkpoint: fc.boolean(),
}), runCancellationScenario)

// cancellationForwarding checks cancellationIsolation and immediate-child forwarding from core/quint/cancellation.qnt.
// A completed intermediate child stops propagation, matching the model's unconditionalCascade counterexample.
export const cancellationForwarding = fc.asyncProperty(fc.record({
  completedChild: fc.boolean(), duplicates: fc.integer({ min: 0, max: 3 }), reopens: fc.integer({ min: 0, max: 2 }), reason: fc.string({ maxLength: 20 }),
}), options => Effect.runPromise(Effect.gen(function* () {
  const histories: RuntimeEvent<Event>[][] = [[], [], [], []]
  const references = new Map<number, EffectRef>()
  const runtimes = new Map<number, ActorRuntime<Event>>()
  const executions = [0, 0, 0, 0]
  const stores = new Map<number, { readonly cancel: ActorRuntime<Event>["cancel"]; readonly wait: Effect.Effect<void, Error>; readonly close: Effect.Effect<void> }>()
  const open = (id: number) => createActorStore({ actor: actor(id), events: histories[id]!, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(),
    onEvent: event => { histories[id]!.push(event) },
    services: runtime => {
      runtimes.set(id, runtime)
      return Layer.merge(Job.layer((input, { ref }) => Effect.sync(() => {
        executions[input]!++
        references.set(input, ref)
        return Job.defer({ executor: "remote", id: String(input) })
      }), { cancel: (input, { reason }) => input < 2 ? Effect.suspend(() => stores.get(input + 1)!.cancel(references.get(input + 1)!, reason)) : Effect.void }),
      Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }))
    },
  })
  yield* Effect.gen(function* () {
    for (let id = 0; id < 4; id++) {
      const store = yield* open(id)
      stores.set(id, store)
      yield* store.actions.start()
      yield* store.wait
    }
    const finish = (id: number) => runtimes.get(id)!.send([durablePromise(references.get(id)!, { success: Schema.Finite }).succeed(id)])
    if (options.completedChild) {
      yield* finish(1)
      yield* stores.get(1)!.wait
    }
    for (let count = 0; count <= options.duplicates; count++) {
      yield* stores.get(0)!.cancel(references.get(0)!, options.reason)
      for (const store of stores.values()) yield* store.wait
    }
    for (let cycle = 0; cycle < options.reopens; cycle++) {
      yield* stores.get(0)!.close
      stores.set(0, yield* open(0))
      for (const store of stores.values()) yield* store.wait
    }
    for (let id = 0; id < 4; id++) {
      const cancelled = histories[id]!.filter(event => event.type === "EffectCancelled")
      const expected = id === 0 || (!options.completedChild && id < 3)
      if (cancelled.length !== Number(expected) || executions[id] !== 1) return yield* Effect.fail(new RuntimeError("Cancellation escaped ownership, crossed a completed child, or restarted work"))
      if (expected) {
        yield* finish(id)
        yield* stores.get(id)!.wait
        if (histories[id]!.some(event => event.type === "PromiseSettled")) return yield* Effect.fail(new RuntimeError("Cancelled descendant accepted a late result"))
      }
    }
    yield* finish(3)
    yield* stores.get(3)!.wait
    if (histories[3]!.filter(event => event.type === "Returned").length !== 1) return yield* Effect.fail(new RuntimeError("Unrelated execution was interrupted"))
  }).pipe(Effect.ensuring(Effect.forEach(stores.values(), store => store.close, { discard: true })))
}).pipe(Effect.scoped, Effect.timeout(5_000))))

// cancellationBatchIsolation checks validBatchPreserved from core/quint/terminalDelivery.qnt.
export const cancellationBatchIsolation = fc.asyncProperty(fc.record({
  cancelled: fc.integer({ min: 0, max: 1 }), reverse: fc.boolean(), value: fc.integer({ min: -100, max: 100 }), duplicates: fc.integer({ min: 0, max: 3 }),
}), options => Effect.runPromise(Effect.gen(function* () {
  let runtime!: ActorRuntime<Event>
  const definition = defineActor("batch-cancellation", Effect.sync(() => {
    const started = durableAtom({ name: "test.batch-cancellation", input: Event, schema: Schema.Boolean, initial: false, reduce: (state, event) => state || event.type === "Started" })
    const requests = [0, 1].map(id => Job.request({ tag: String(id), input: id, onSettled: () => [{ type: "Returned" }] }))
    return { atom: Object.assign(effectAtom(get => ({ view: requests.map(request => get(request.result)), events: {}, acts: get(started) ? Object.fromEntries(requests.map(request => [request.id, request])) : {} })), { schema: Event }), actions: { start: () => ({ type: "Started" as const }) } }
  }))
  const store = yield* createActorStore({ actor: definition, actorContext: () => Context.empty(),
    services: host => {
      runtime = host
      return Layer.merge(Job.layer(input => Effect.succeed(Job.defer({ executor: "remote", id: String(input) }))), Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }))
    },
  })
  yield* Effect.gen(function* () {
    yield* store.actions.start()
    yield* store.wait
    const refs = store.snapshot().deferred().map(work => work.ref)
    yield* store.cancel(refs[options.cancelled]!, "cancelled")
    yield* store.wait
    const batch = refs.map(ref => durablePromise(ref, { success: Schema.Finite }).succeed(options.value))
    if (options.reverse) batch.reverse()
    for (let index = 0; index <= options.duplicates; index++) yield* runtime.send(batch)
    yield* store.wait
    const states = store.getState().view
    const valid = states[1 - options.cancelled]!
    const cancelled = states[options.cancelled]!
    if (valid.status !== "fulfilled" || valid.value !== options.value || cancelled.status !== "rejected") return yield* Effect.fail(new RuntimeError("Cancelled batch member consumed an unrelated result"))
    if (store.snapshot().events.filter(event => event.type === "Returned").length !== 2 || store.snapshot().events.filter(event => event.type === "PromiseSettled").length !== 1) return yield* Effect.fail(new RuntimeError("Batch delivery changed terminal callback multiplicity"))
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(5_000))))
