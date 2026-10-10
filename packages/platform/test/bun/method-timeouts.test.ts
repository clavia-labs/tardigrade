import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { defineActor, effectAtom, ExecutionHandle, ExecutionResult } from "@clavia/tardigrade-core"
import { defineLibrary, MethodExecution, MethodPromiseTimeout, toolsFromLibraries } from "@clavia/tardigrade-libraries"
import { tools } from "@clavia/tardigrade-agent/atoms/tools"
import { ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { Generate } from "@clavia/tardigrade-agent/contracts/acts"
import { generate, Model } from "@clavia/tardigrade-agent/services/model"
import { bunPromises } from "../../src/bun/promises"
import { createTestStore } from "../properties/runtime/store"

test("library promise timeout validates annotations and survives tool compilation", () => {
  const rpc = Rpc.make("job", { payload: Schema.Struct({}), success: Schema.String })
  for (const timeout of [0, -1, 1.5, Infinity]) expect(() => defineLibrary({ name: "jobs", description: "", methods: [rpc.annotate(MethodExecution, "background").annotate(MethodPromiseTimeout, timeout)] })).toThrow("positive safe integer")
  expect(() => defineLibrary({ name: "jobs", description: "", methods: [rpc.annotate(MethodPromiseTimeout, 100)] })).toThrow("background")
  const implementation = defineLibrary({ name: "jobs", description: "", methods: [rpc.annotate(MethodExecution, "background").annotate(MethodPromiseTimeout, 500)] }).implement({ job: () => Effect.succeed("done") })
  expect(toolsFromLibraries([implementation])[0]!.spec.promiseTimeoutMs).toBe(500)
})

test("inference promise uses its model waiting budget", async () => {
  const actor = defineActor("inference-timeout", Effect.sync(() => {
    const request = Generate.request({ input: { model: { provider: "openrouter", model_id: "test" }, system: "", tools: [], context: [] } })
    return { schema: Schema.Struct({ type: Schema.Literal("Unused") }), atom: effectAtom(get => {
      const view = get(request.result)
      return { view, events: {}, acts: view.status === "pending" ? { generate: request } : {} }
    }) }
  }))
  const store = await Effect.runPromise(createTestStore({ actor, promises: { timeoutMs: 10 }, actorContext: Context.pick(), services: () => generate.pipe(Layer.provideMerge(Layer.succeed(Model, {
    promiseTimeoutMs: 500,
    call: () => Effect.sleep(80).pipe(Effect.as({ text: "done", toolCalls: [] })),
  }))) }))
  try {
    await Effect.runPromise(store.wait)
    expect(store.getState().view).toEqual({ status: "fulfilled", value: { text: "done", toolCalls: [] } })
  } finally { await Effect.runPromise(store.close) }
})

for (const executor of ["local", "remote"] as const) test(`${executor} library promise outlives the host default`, async () => {
  const startedAt = Date.now()
  const rpc = Rpc.make("job", { payload: Schema.Struct({}), success: executor === "local" ? Schema.String : ExecutionHandle, error: Schema.String })
    .annotate(MethodExecution, "background").annotate(MethodPromiseTimeout, 500)
  const library = defineLibrary({ name: "jobs", description: "", methods: [rpc] }).implement({ job: () => executor === "remote"
    ? Effect.succeed({ executor: "remote", id: "job" })
    : Effect.sleep(80).pipe(Effect.as("done")) }, { submit: executor === "remote" ? ["job"] : [] })
  const actor = defineActor("method-timeout", Effect.map(tools(), atom => ({ atom })))
  const store = await Effect.runPromise(createTestStore({ actor, promises: { timeoutMs: 10, pollIntervalMs: 5 }, actorContext: Context.pick(ToolCatalog),
    services: runtime => Layer.merge(toolActs([library]), bunPromises(runtime, {
      poll: () => Effect.succeed(Date.now() - startedAt < 80 ? { status: "pending" as const } : { status: "fulfilled" as const, value: "done" }),
      deliver: settlement => runtime.send([settlement]),
    })),
  }))
  try {
    await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "job", providerId: "provider", name: "jobs__job", input: {} }] }]))
    await Effect.runPromise(Effect.gen(function* () {
      while (!store.snapshot().events.some(event => event.type === "PromiseSettled")) yield* Effect.sleep(5)
      yield* store.wait
    }).pipe(Effect.timeout(2_000)))
    const events = store.snapshot().events
    const settlement = events.find(event => event.type === "PromiseSettled")
    expect(settlement?.type === "PromiseSettled" && settlement.result).toEqual({ status: "fulfilled", value: executor === "local" ? { content: [{ type: "text", text: '"done"' }] } : "done" })
    const effect = events.find(event => event.type === "EffectSettled")
    const value = Schema.decodeUnknownSync(ExecutionResult)(effect?.type === "EffectSettled" && effect.outcome.status === "fulfilled" ? effect.outcome.value : null)
    expect(value.type === "promise" && value.deadlineAt!).toBeGreaterThanOrEqual(startedAt + 500)
  } finally { await Effect.runPromise(store.close) }
})
