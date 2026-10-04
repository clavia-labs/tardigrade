import { Context, Effect, Schema } from "effect"
import { act, defineActor, durableAtom, durablePromise, effectAtom, EffectExecution, ExecutionResult, PromiseTimedOut, RuntimeError } from "@clavia/tardigrade-core"
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
