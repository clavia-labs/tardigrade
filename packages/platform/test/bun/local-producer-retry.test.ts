import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Schema } from "effect"
import { act, defineActor, durablePromise, effectAtom, EffectExecution, ExecutionResult, type EffectRef, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { createTestStore } from "../properties/runtime/store"

test("reopening retries the local effect and recreates its producer with the original deadline", async () => {
  const Event = Schema.Struct({ type: Schema.Literal("Unused") })
  type Event = typeof Event.Type
  const Job = act({ name: "producer.retry", input: Schema.Null, success: Schema.String, failure: Schema.String })
  const actor = defineActor("producer-retry", Effect.sync(() => {
    const request = Job.request({ input: null })
    return { schema: Event, atom: effectAtom(get => {
      const view = get(request.result)
      return { view, events: {}, acts: view.status === "pending" ? { job: request } : {} }
    }) }
  }))
  const records: Recorded<Event>[] = []
  const refs: EffectRef[] = []
  const producers: Deferred.Deferred<string>[] = []
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires an undefined checkpoint result.
    readCheckpoint: Effect.succeed(undefined),
    append: (expected, entries) => Effect.sync(() => { expect(expected).toBe(records.length); records.push(...entries) }),
    appendWithCheckpoint: () => Effect.die("Unexpected checkpoint"),
  }
  const open = () => createTestStore({ actor, journal, checkpoint: { mode: "manual" }, promises: { timeoutMs: refs.length ? 5_000 : 1_000 }, actorContext: Context.pick(), services: () => Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    refs.push(execution.ref)
    const producer = yield* Deferred.make<string>()
    producers.push(producer)
    if (producers.length > 1) yield* Deferred.succeed(producer, "recreated")
    const promise = durablePromise(execution.ref, { success: Schema.String, error: Schema.String })
    const handle = yield* execution.fork(Deferred.await(producer).pipe(Effect.map(promise.succeed)), { timeoutMs: producers.length > 1 ? 5_000 : 1_000 })
    return Job.defer(handle)
  }).pipe(Effect.mapError(String))) })
  const first = await Effect.runPromise(open())
  let originalDeadline: number | undefined
  try {
    await Effect.runPromise(Effect.gen(function* () {
      while (!records.some(({ event }) => event.type === "EffectSettled")) yield* Effect.sleep(1)
    }).pipe(Effect.timeout(2_000)))
    const event = records.find(({ event }) => event.type === "EffectSettled")!.event
    const envelope = Schema.decodeUnknownSync(ExecutionResult)(event.type === "EffectSettled" && event.outcome.status === "fulfilled" ? event.outcome.value : null)
    originalDeadline = envelope.type === "promise" ? envelope.deadlineAt : undefined
    expect(originalDeadline).toBeDefined()
  } finally { await Effect.runPromise(first.close) }
  const reopened = await Effect.runPromise(open())
  try {
    await Effect.runPromise(reopened.wait.pipe(Effect.timeout(2_000)))
    expect(reopened.getState().view).toEqual({ status: "fulfilled", value: "recreated" })
    expect(refs).toHaveLength(2)
    expect(refs[1]).toEqual(refs[0])
    expect(producers[1]).not.toBe(producers[0])
    expect(records.filter(({ event }) => event.type === "EffectRequested")).toHaveLength(1)
    const accepted = records.filter(({ event }) => event.type === "EffectSettled")
    expect(accepted).toHaveLength(1)
    const event = accepted[0]!.event
    const envelope = Schema.decodeUnknownSync(ExecutionResult)(event.type === "EffectSettled" && event.outcome.status === "fulfilled" ? event.outcome.value : null)
    expect(envelope.type === "promise" && envelope.deadlineAt).toBe(originalDeadline)
    expect(records.filter(({ event }) => event.type === "PromiseSettled")).toHaveLength(1)
  } finally { await Effect.runPromise(reopened.close) }
})
