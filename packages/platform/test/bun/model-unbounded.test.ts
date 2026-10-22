import { expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Response } from "effect/unstable/ai"
import { createActorStore, defineActor, effectAtom, ExecutionResult } from "@clavia/tardigrade-core"
import { Generate } from "@clavia/tardigrade-agent/contracts/acts"
import { ModelReply } from "@clavia/tardigrade-agent/contracts/events"
import { Model, modelActs } from "@clavia/tardigrade-agent/services/model"
import { completionState } from "../fixtures/completion-state"
import { contentServices } from "../fixtures/agent"

const input = { model: { provider: "fixture", model_id: "test" }, system: "Reply", tools: [], context: [{ role: "user" as const, text: "Hello" }] }
const completion = completionState("model.unbounded", ModelReply)
const actor = defineActor("unbounded-model", Effect.sync(() => {
  const request = Generate.request({ input, onSettled: completion.onSettled })
  return { schema: completion.event, atom: effectAtom(get => ({ view: get(completion.state), events: {}, acts: get(completion.state).status === "pending" ? { generate: request } : {} })) }
}))

for (const mode of ["active", "first-chunk", "idle", "cancel"] as const) test(`unbounded model call: ${mode}`, () => Effect.runPromise(Effect.gen(function* () {
  const clock = yield* TestClock.make()
  yield* Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    let calls = 0
    const start = Stream.make(Response.makePart("text-start", { id: "reply" }))
    const chunks = Stream.range(0, 3).pipe(Stream.mapEffect(() => Effect.sleep(60_000).pipe(Effect.as(Response.makePart("text-delta", { id: "reply", delta: "x" })))))
    const finish = Stream.fromIterable([
      Response.makePart("text-end", { id: "reply" }),
      Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
    ])
    const stream = mode === "active" ? Stream.concat(Stream.concat(start, chunks), finish) : mode === "first-chunk" ? Stream.never : Stream.concat(start, Stream.never)
    const silenceMs = mode === "active" || mode === "cancel" ? 70_000 : 10
    const store = yield* createActorStore({ actor, actorContext: () => Context.empty(), services: () => contentServices(() => {
      calls++
      Deferred.doneUnsafe(entered, Effect.void)
    }, { model: { timeoutMs: null, promiseTimeoutMs: null }, stream, request: { timeout: { firstChunkMs: silenceMs, idleMs: silenceMs } } }) })
    yield* Effect.gen(function* () {
      yield* Deferred.await(entered)
      while (!store.snapshot().deferred().length) yield* Effect.yieldNow
      yield* store.recover
      const pending = store.snapshot().deferred()[0]!
      expect(pending.unbounded).toBe(true)
      expect(pending.deadlineAt).toBeUndefined()
      expect(store.recoveryState().status).toBe("running")
      if (mode === "cancel") yield* store.cancel(pending.ref, "stop")
      else yield* clock.adjust(mode === "active" ? 300_000 : 11)
      yield* store.wait
      const result = store.getState().view
      if (mode === "active") expect(result).toMatchObject({ status: "fulfilled", value: { text: "xxxx" } })
      else {
        expect(result.status).toBe("rejected")
        if (result.status === "rejected") {
          if (mode === "cancel") expect(result.reason).toMatchObject({ _tag: "Cancelled", reason: "stop" })
          else expect(String(result.reason)).toContain(mode === "idle" ? "idleMs" : "firstChunkMs")
        }
      }
      expect(calls).toBe(1)
    }).pipe(Effect.ensuring(store.close))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped, Effect.timeout(5_000))))

test("unbounded external model submission rejects before starting the producer", () => Effect.runPromise(Effect.gen(function* () {
  let submissions = 0
  const store = yield* createActorStore({ actor, actorContext: () => Context.empty(), services: () => modelActs.pipe(Layer.provide(Layer.succeed(Model, {
    promiseTimeoutMs: null,
    call: () => Effect.die("Unexpected local call"),
    submit: () => Effect.sync(() => { submissions++; return { executor: "remote", id: "external" } }),
  }))) })
  yield* Effect.gen(function* () {
    yield* store.wait
    expect(submissions).toBe(0)
    expect(store.getState().view).toMatchObject({ status: "rejected", reason: expect.stringContaining("Unbounded promises require a local producer") })
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped)))

test("promise envelopes distinguish unbounded local work from legacy records", () => {
  const decode = Schema.decodeUnknownSync(ExecutionResult)
  const handle = { executor: "local", id: "producer" }
  expect(decode({ type: "promise", handle, unbounded: true })).toEqual({ type: "promise", handle, unbounded: true })
  expect(decode({ type: "promise", handle })).toEqual({ type: "promise", handle })
  expect(() => decode({ type: "promise", handle, unbounded: true, deadlineAt: 100 })).toThrow()
  expect(() => decode({ type: "promise", handle: { executor: "remote", id: "external" }, unbounded: true })).toThrow()
})
