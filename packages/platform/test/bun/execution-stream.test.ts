import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Response } from "effect/unstable/ai"
import { HttpServerResponse } from "effect/unstable/http"
import { act, actorMethod, createActorStore, createExecutionStream, defineActor, durableAtom, EffectExecution, effectAtom, event, type ActorRuntime, type ExecutionUpdate } from "@clavia/tardigrade-core"
import { createBunHost, methodHttp } from "../../src/bun"
import { Generate } from "@clavia/tardigrade-agent/contracts/acts"
import { generate, Model } from "@clavia/tardigrade-agent/services/model"
import { collectModelStream } from "@clavia/tardigrade-agent/services/model-stream"
import { DEFAULT_TIMEOUT } from "@clavia/tardigrade-model/stream/policy"
import { executionStreamSse } from "../../src/shared/execution-stream-sse"

const address = { actor: "spike", instance: "main", thread: "root" }
const update = (sequence: number): ExecutionUpdate => ({ address, ref: { seq: 0, atom: "job", act: "run" }, attemptId: "attempt", sequence, payload: { type: "tool.progress", completed: sequence } })

test("execution stream fans out and a slow subscriber retains the configured recent updates", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const execution = yield* createExecutionStream({ bufferCapacity: 2 })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const slow: number[] = []
    const slowFiber = yield* execution.stream.pipe(Stream.take(3), Stream.runForEach(item => Effect.gen(function* () {
      slow.push(item.sequence)
      if (item.sequence === 0) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release) }
    })), Effect.forkChild)
    const fastFiber = yield* execution.stream.pipe(Stream.take(6), Stream.runCollect, Effect.forkChild)
    yield* Effect.yieldNow
    yield* execution.publish(update(0))
    yield* Deferred.await(entered)
    for (let sequence = 1; sequence < 6; sequence++) { yield* execution.publish(update(sequence)); yield* Effect.yieldNow }
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(slowFiber)
    expect(slow).toEqual([0, 4, 5])
    expect((yield* Fiber.join(fastFiber)).map(item => item.sequence)).toEqual([0, 1, 2, 3, 4, 5])
    expect(execution.policy.bufferCapacity).toBe(2)
    yield* execution.close
  })))
})

test("runtime execution updates are ephemeral and stops publishing after cancellation", async () => {
  const Start = event({ type: "Start" })
  const Job = act({ name: "test.progress", input: Schema.Null, success: Schema.Null, failure: Schema.String })
  const started = durableAtom({ name: "progress.started", input: Start, schema: Schema.Boolean, initial: false, reduce: () => true })
  const actor = defineActor(address.actor, Effect.sync(() => {
    const request = Job.request({ input: null })
    return { schema: Start, atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: get(started) ? { job: request } : {} })) }
  }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let runtime!: ActorRuntime<typeof Start.Type>
    let publish!: typeof EffectExecution.Service.publish
    const entered = yield* Deferred.make<void>()
    const store = yield* createActorStore({ actor, actorContext: Context.pick(), services: current => {
      runtime = current
      return Job.layer(() => Effect.gen(function* () {
        const execution = yield* EffectExecution
        publish = execution.publish
        yield* publish({ type: "tool.progress", message: "working" })
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      }))
    } })
    const seen: ExecutionUpdate[] = []
    const subscriber = yield* store.execution.stream.pipe(Stream.runForEach(item => Effect.sync(() => { seen.push(item) })), Effect.forkChild)
    yield* Effect.yieldNow
    yield* runtime.send([{ type: "Start" }])
    yield* Deferred.await(entered)
    expect(seen.length).toBe(1)
    yield* store.cancel(seen[0]!.ref, "stop")
    yield* store.wait
    yield* publish({ type: "tool.progress", message: "late" })
    yield* Effect.yieldNow
    expect(seen.length).toBe(1)
    expect(JSON.stringify(store.snapshot().events)).not.toContain("tool.progress")
    yield* store.close
    expect((yield* Fiber.await(subscriber))._tag).toBe("Success")
  })))
})

test("model generation publishes through execution and preserves the durable reply", async () => {
  const Start = event({ type: "Start" })
  const model = { provider: "fixture", model_id: "stream" }
  const started = durableAtom({ name: "model.progress.started", input: Start, schema: Schema.Boolean, initial: false, reduce: () => true })
  const actor = defineActor(address.actor, Effect.sync(() => {
    const request = Generate.request({ input: { model, system: "", tools: [], context: [] } })
    return { schema: Start, atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: get(started) ? { generate: request } : {} })) }
  }))
  const parts = [Response.makePart("text-start", { id: "text" }), Response.makePart("text-delta", { id: "text", delta: "hello" }), Response.makePart("text-end", { id: "text" }), Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) })]
  const services = generate.pipe(Layer.provideMerge(Layer.succeed(Model, { call: (input, execution) => Effect.gen(function* () {
    if (!execution) return yield* Effect.die("Missing execution context")
    const result = yield* collectModelStream(Stream.fromIterable(parts), input.model, execution, DEFAULT_TIMEOUT)
    return { text: result.response.text, toolCalls: [] }
  }) })))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let runtime!: ActorRuntime<typeof Start.Type>
    const store = yield* createActorStore({ actor, actorContext: Context.pick(), services: current => { runtime = current; return services } })
    const subscriber = yield* store.execution.stream.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
    yield* Effect.yieldNow
    yield* runtime.send([{ type: "Start" }])
    yield* store.wait
    const updates = yield* Fiber.join(subscriber)
    expect(updates[0]?.payload).toMatchObject({ type: "model.delta", purpose: "inference", text: "hello" })
    expect(store.getState().view).toEqual({ status: "fulfilled", value: { text: "hello", toolCalls: [] } })
    expect(JSON.stringify(store.snapshot().events)).not.toContain("model.delta")
    yield* store.close
  })))
})

test("SSE uses native encoding and filters updates to the requested thread", async () => {
  const response = executionStreamSse(Stream.fromIterable([update(0), { ...update(1), address: { ...address, thread: "other" } }]), address)
  const web = HttpServerResponse.toWeb(response)
  expect(web.headers.get("content-type")).toContain("text/event-stream")
  const body = await web.text()
  expect(body).toContain("event: tool.progress\n")
  expect(body).toContain('"sequence":0')
  expect(body).not.toContain('"sequence":1')
  expect(body).not.toContain("\nid:")
})

test("execution stream policy rejects invalid capacities", async () => {
  for (const bufferCapacity of [0, -1, 1.5, Infinity]) {
    const exit = await Effect.runPromise(createExecutionStream({ bufferCapacity }).pipe(Effect.exit))
    expect(exit._tag).toBe("Failure")
  }
})

test("host SSE identifies the thread and client disconnect leaves execution running", async () => {
  const Start = event({ type: "Start" })
  const Job = act({ name: "test.progress.http", input: Schema.Null, success: Schema.Null, failure: Schema.String })
  const started = durableAtom({ name: "progress.http.started", input: Start, schema: Schema.Boolean, initial: false, reduce: () => true })
  const actor = defineActor(address.actor, Effect.sync(() => {
    const request = Job.request({ input: null })
    return {
      schema: Start,
      atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: get(started) ? { job: request } : {} })),
      methods: { run: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Null, onReceive: Start.from(() => ({})), result: (_, get) => get(request.result).status === "fulfilled" ? { status: "completed", output: null } : undefined }) },
    }
  }))
  const release = await Effect.runPromise(Deferred.make<void>())
  const storage = await mkdtemp(join(tmpdir(), "tardigrade-progress-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, executionStream: { bufferCapacity: 2 }, actorContext: Context.pick(), services: () => Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    yield* execution.publish({ type: "tool.progress", message: "working" })
    yield* Deferred.await(release)
    return null
  })) }))
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: address.instance, name: address.thread }))
    const handler = methodHttp(host)
    const response = await handler(new Request("http://test/v1/actors/main/threads/root/execution/stream"))
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const pending = reader.read()
    const receipt = await Effect.runPromise(thread.invoke("run", null, { id: "run" }))
    expect(receipt.id).toBe("run")
    const chunk = new TextDecoder().decode((await pending).value)
    expect(chunk).toContain("event: tool.progress\n")
    const data = JSON.parse(chunk.split("data: ")[1]!.trim())
    expect(data.address).toEqual(address)
    expect(data.sequence).toBe(0)
    expect(data.ref.act).toBe(Job.name)
    await reader.cancel()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(thread.wait)
    expect(thread.getState().view).toEqual({ status: "fulfilled", value: null })
    expect(JSON.stringify(await Effect.runPromise(thread.records()))).not.toContain("tool.progress")
    expect(host.execution.policy.bufferCapacity).toBe(2)
  } finally {
    await Effect.runPromise(host.close)
    await rm(storage, { recursive: true, force: true })
  }
})
