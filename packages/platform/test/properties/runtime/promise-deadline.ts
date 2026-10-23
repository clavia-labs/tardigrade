import { strict as assert } from "node:assert"
import { Clock, Context, Deferred, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as fc from "fast-check"
import { act, cancel, defineActor, durableAtom, durablePromise, effectAtom, EffectExecution, EffectRef, ExecutionResult, PromiseTimedOut, RuntimeError, Scheduler, type WakeRequest } from "@clavia/tardigrade-core"
import { createTestStore } from "./store"

// promiseDeadline checks hung local work expires once and late completion cannot replace the terminal result.
export const promiseDeadline = () => Effect.runPromise(Effect.gen(function* () {
  const Start = Schema.Struct({ type: Schema.Literal("Start") })
  const Done = Schema.Struct({ type: Schema.Literal("Done"), timedOut: Schema.Boolean })
  const Event = Schema.Union([Start, Done])
  const Job = act({ name: "test.deadline", input: Schema.Struct({}), success: Schema.String, failure: Schema.String })
  const actor = defineActor("deadline", Effect.sync(() => {
    const state = durableAtom({ name: "deadline", input: Event, schema: Schema.Struct({ started: Schema.Boolean, done: Schema.Boolean, timedOut: Schema.Boolean }), initial: { started: false, done: false, timedOut: false }, reduce: (s, e) => e.type === "Start" ? { ...s, started: true } : { ...s, done: true, timedOut: e.timedOut } })
    const job = Job.request({ input: {}, onSettled: result => [{ type: "Done", timedOut: result.status === "rejected" && Schema.is(PromiseTimedOut)(result.reason) }] })
    return { schema: Event, atom: effectAtom(get => { const view = get(state); return { view, events: {}, acts: view.started && !view.done ? { job } : {} } }) }
  }))
  let cancelled = false
  const store = yield* createTestStore({ actor, promises: { timeoutMs: 30 }, actorContext: () => Context.empty(), services: () => Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    const handle = yield* execution.fork(Effect.never)
    return Job.defer(handle)
  }).pipe(Effect.mapError(String)), { cancel: () => Effect.sync(() => { cancelled = true }) }) })
  yield* Effect.gen(function* () {
    yield* store.send([{ type: "Start" }])
    yield* store.wait
    const state = store.getState().view
    if (!state.done || !state.timedOut || cancelled) return yield* Effect.fail(new RuntimeError("Deadline failed to reject without cancellation"))
    const snapshot = store.snapshot()
    const settlement = snapshot.events.find(event => event.type === "EffectSettled")
    if (!settlement || settlement.type !== "EffectSettled" || settlement.outcome.status !== "fulfilled") return yield* Effect.fail(new RuntimeError("Missing effect settlement"))
    const envelope = yield* Schema.decodeUnknownEffect(ExecutionResult)(settlement.outcome.value)
    if (envelope.type !== "promise" || envelope.deadlineAt === undefined) return yield* Effect.fail(new RuntimeError("Missing durable deadline"))
    const promise = durablePromise(settlement.ref, { success: Schema.String, error: Schema.String })
    yield* store.send([promise.succeed("late")])
    yield* store.wait
    if (store.snapshot().events.filter(e => e.type === "PromiseSettled").length !== 1 || store.snapshot().events.filter(e => e.type === "Done").length !== 1) return yield* Effect.fail(new RuntimeError("Late result changed terminal history"))
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(2_000)))

// deadlineProgress checks scheduled expiry and cancellation progress while another execution or producer remains running (quint/deadlineProgress.qnt, deadlineSettles).
export const deadlineProgress = fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 1_000 }), async (deferred, budget) => Effect.runPromise(Effect.gen(function* () {
  const clock = yield* TestClock.make()
  yield* Effect.gen(function* () {
    const Start = Schema.Struct({ type: Schema.Literal("Start") })
    const Accepted = Schema.Struct({ type: Schema.Literal("Accepted"), ref: EffectRef })
    const Expired = Schema.Struct({ type: Schema.Literal("Expired"), timedOut: Schema.Boolean })
    const Event = Schema.Union([Start, Accepted, Expired])
    const Deadline = act({ name: "test.deadline-progress", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const Hang = act({ name: "test.deadline-hang", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const actor = defineActor("deadline-progress", Effect.sync(() => {
      const state = durableAtom({ name: "deadline-progress", input: Event,
        schema: Schema.Struct({ started: Schema.Boolean, done: Schema.Boolean, timedOut: Schema.Boolean, ref: Schema.NullOr(EffectRef) }),
        initial: { started: false, done: false, timedOut: false, ref: null },
        reduce: (state, event) => event.type === "Start" ? { ...state, started: true } : event.type === "Accepted" ? { ...state, ref: event.ref } : { ...state, done: true, timedOut: event.timedOut },
      })
      const deadline = Deadline.request({ input: null, onSettled: result => [{ type: "Expired", timedOut: result.status === "rejected" && Schema.is(PromiseTimedOut)(result.reason) }] })
      const hang = Hang.request({ input: null, onRequested: ref => [{ type: "Accepted", ref }] })
      return { schema: Event, atom: effectAtom(get => {
        const view = get(state)
        return { view, events: {}, acts: !view.started ? {} : view.done ? view.ref ? { cancel: cancel(view.ref, "deadline") } : {} : { deadline, hang } }
      }) }
    }))
    const entered = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const wakes: WakeRequest[] = []
    const store = yield* createTestStore({ actor, attemptTimeoutMs: null, actorContext: Context.pick(), services: () => Layer.mergeAll(
      Deadline.layer(() => Effect.gen(function* () {
        const execution = yield* EffectExecution
        return Deadline.defer(yield* execution.fork(Effect.never, { timeoutMs: budget }))
      }).pipe(Effect.mapError(String))),
      Hang.layer(() => Effect.gen(function* () {
        const work = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
        if (!deferred) return yield* work
        const execution = yield* EffectExecution
        return Hang.defer(yield* execution.fork(work, { timeoutMs: null }))
      }).pipe(Effect.mapError(String))),
      Layer.succeed(Scheduler, { schedule: wake => Effect.sync(() => { wakes.push(wake) }), cancel: () => Effect.void, restore: Effect.void }),
    ) })
    yield* Effect.gen(function* () {
      yield* store.send([{ type: "Start" }])
      yield* Deferred.await(entered)
      while (!wakes.length || (deferred && store.snapshot().deferred().length !== 2)) yield* Effect.yieldNow
      assert.equal(wakes[0]!.dueAt, budget)
      yield* clock.adjust(budget - 1)
      yield* store.resume
      assert.equal(store.getState().view.done, false)
      yield* clock.adjust(1)
      yield* store.resume
      assert.equal(store.getState().view.timedOut, true, "Scheduled expiry must progress while the other act is running")
      yield* Deferred.await(interrupted)
      yield* store.wait
      const snapshot = store.snapshot()
      const ref = snapshot.events.find(event => event.type === "EffectRequested" && event.ref.act === Deadline.name)
      assert.ok(ref?.type === "EffectRequested")
      const promise = durablePromise(ref.ref, { success: Schema.Null, error: Schema.String })
      yield* store.send([promise.succeed(null)])
      yield* store.resume
      yield* store.wait
      const events = store.snapshot().events
      assert.equal(events.filter(event => event.type === "PromiseSettled" && event.ref.act === Deadline.name).length, 1)
      assert.equal(events.filter(event => event.type === "Expired").length, 1)
      assert.equal(events.filter(event => event.type === "EffectCancelled" && event.ref.act === Hang.name).length, 1)
      assert.equal(store.getState().view.timedOut, true)
    }).pipe(Effect.ensuring(store.close))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped, Effect.timeout(5_000))))
