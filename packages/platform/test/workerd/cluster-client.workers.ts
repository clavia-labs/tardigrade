import { expect, test } from "vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { ClusterSchema, Entity, TestRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { methodResult } from "@clavia/tardigrade-core"
import { createMethodClient } from "../../src/client"
import { workerdSlowActFixture } from "../fixtures/workerd/slow-act-fixture"
import { waitFor } from "../fixtures/wait"

const Caller = Entity.make("SlowCaller", [Rpc.make("Start", {
  payload: { id: Schema.String }, success: Schema.String, error: Schema.String,
  primaryKey: payload => payload.id,
}), Rpc.make("Result", { payload: { id: Schema.String }, success: Schema.Union([methodResult(Schema.Int), Schema.Struct({ status: Schema.Literal("pending") })]), error: Schema.String })]).annotateRpcs(ClusterSchema.Persisted, true)

test("DO work survives Cluster caller shutdown, a lost acceptance, and a cold DO restart", async () => {
  const fixture = await workerdSlowActFixture({ workMs: 0, value: 42, hold: true })
  const accepted = Deferred.makeUnsafe<void>()
  let loseAcceptance = true
  const client = createMethodClient({ ...fixture.clientOptions, policy: { resultTimeoutMs: 5_000, pollIntervalMs: 5 }, fetch: async request => {
    const response = await fixture.clientOptions.fetch(request)
    if (loseAcceptance && request.method === "POST" && response.status === 202) {
      loseAcceptance = false
      await response.text()
      throw new Error("injected lost acceptance")
    }
    return response
  } })
  const layer = Caller.toLayer({ Start: ({ payload }) => Effect.gen(function* () {
    yield* client.invoke("run", null, { id: payload.id }).pipe(Effect.retry({ times: 1 }))
    return payload.id
  }).pipe(Effect.mapError(String)), Result: ({ payload }) => client.result("run", payload.id).pipe(Effect.mapError(String)) })
  const abandoned = Effect.runFork(Effect.gen(function* () {
    const caller = (yield* Caller.client)(fixture.clientOptions.instance)
    yield* caller.Start({ id: "run" })
    yield* Deferred.succeed(accepted, undefined)
    return yield* Effect.never
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestRunner.layer)))))
  try {
    await Effect.runPromise(Deferred.await(accepted).pipe(Effect.timeout("5 seconds")))
    await waitFor(fixture.log, log => log.some(entry => entry.kind === "start"))
    await Effect.runPromise(Fiber.interrupt(abandoned))
    expect(await Effect.runPromise(client.result("run", "run"))).toEqual({ status: "pending" })
    expect((await fixture.records()).filter(record => record.message?.id === "run")).toHaveLength(1)
    await fixture.restart()
    await waitFor(fixture.log, log => log.filter(entry => entry.kind === "start").length === 2)
    await fixture.release()
    const replacementClient = createMethodClient(fixture.clientOptions)
    const finished = await Effect.runPromise(replacementClient.wait("run", "run"))
    expect(finished).toEqual({ status: "completed", output: 42 })
    if (finished.status === "completed") { const output: number = finished.output; expect(output).toBe(42) }
    await Effect.runPromise(replacementClient.invoke("run", null, { id: "run" }))
    const lostResult = createMethodClient({ ...fixture.clientOptions, fetch: async request => {
      const response = await fixture.clientOptions.fetch(request)
      await response.text()
      throw new Error("injected lost result response")
    } })
    await expect(Effect.runPromise(lostResult.result("run", "run"))).rejects.toThrow("injected lost result response")
    expect(await Effect.runPromise(replacementClient.result("run", "run"))).toEqual(finished)
    expect(await Effect.runPromise(Effect.gen(function* () {
      const caller = (yield* Caller.client)(fixture.clientOptions.instance)
      return yield* caller.Result({ id: "run" })
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestRunner.layer)))))).toEqual(finished)
    expect((await fixture.records()).filter(record => record.message?.id === "run")).toHaveLength(1)
    expect((await fixture.log()).filter(entry => entry.kind === "done")).toHaveLength(1)
  } finally {
    await Effect.runPromise(Fiber.interrupt(abandoned))
    await fixture.close()
  }
}, 15_000)
