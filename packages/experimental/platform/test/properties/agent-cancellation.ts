import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { defineActor, atom, Isolate, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { createActorStore, Promises } from "@clavia/tardigrade-experimental-host"
import { infer } from "@clavia/tardigrade-experimental-agent/atoms/infer"
import { codeMode } from "@clavia/tardigrade-experimental-agent/atoms/code-mode"
import { pendingTools } from "@clavia/tardigrade-experimental-agent/atoms/tools"
import { Generate, Summarize } from "@clavia/tardigrade-experimental-agent/acts"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-experimental-agent/context"
import { codeModeActs } from "@clavia/tardigrade-experimental-agent/services/code-mode"
import { Event, EvaluateCode } from "@clavia/tardigrade-experimental-agent/code-mode/contracts"
import { definePackage, tool } from "@clavia/tardigrade-experimental-packages"

// agentCancellationRecovery checks nextTurnProgress from core/quint/terminalDelivery.qnt.
export const agentCancellationRecovery = fc.asyncProperty(fc.record({ reason: fc.string({ maxLength: 20 }), duplicates: fc.integer({ min: 0, max: 3 }) }), options => Effect.runPromise(Effect.gen(function* () {
  const definition = defineActor("agent-cancellation", Effect.gen(function* () {
    const node = yield* infer<never>(atom(() => ({ system: "", tools: { view: { specs: [] }, events: {}, acts: {} }, context: { view: { position: "ready" as const, messages: [] }, events: {}, acts: {} } })))
    return { atom: node, actions: { message: (turnId: string) => ({ type: "MessageReceived" as const, kind: "message" as const, text: "hello", turnId }) } }
  }))
  const store = yield* createActorStore({ actor: definition, actorContext: Context.pick(ModelInfo), services: () => Layer.mergeAll(
    Layer.succeed(ModelInfo, { model: { provider: "openrouter", model_id: "test" }, contextWindowTokens: 10_000 }),
    Generate.layer(() => Effect.succeed(Generate.defer({ executor: "remote", id: "model" }))),
    Summarize.layer(() => Effect.succeed({ text: "summary", toolCalls: [] })),
    Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
  ) })
  yield* Effect.gen(function* () {
    yield* store.methods.message("first")
    yield* store.wait
    const ref = store.snapshot().deferred()[0]!.ref
    for (let index = 0; index <= options.duplicates; index++) yield* store.cancel(ref, options.reason)
    yield* store.wait
    if (store.getState().view.position !== "idle" || store.snapshot().events.filter(event => event.type === "TurnSettled").length !== 1) return yield* Effect.fail(new RuntimeError("Cancellation stranded the active agent turn"))
    yield* store.methods.message("second")
    yield* store.wait
    if (store.snapshot().events.filter(event => event.type === "ModelCalled").length !== 2) return yield* Effect.fail(new RuntimeError("Cancelled model prevented the next turn"))
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(5_000))))

// codeModeCancellationRecovery checks terminal domain delivery and executor-owned package cancellation.
export const codeModeCancellationRecovery = fc.asyncProperty(fc.record({ reason: fc.string({ maxLength: 20 }), value: fc.integer({ min: -100, max: 100 }) }), options => Effect.runPromise(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  let executions = 0
  const packages = [definePackage({ name: "test", description: "Jobs", methods: [tool({ name: "job", description: "Job", input: Schema.Struct({}), run: () => Effect.gen(function* () {
    executions++
    if (executions === 1) {
      yield* Deferred.succeed(entered, undefined)
      return yield* Effect.never
    }
    return options.value
  }) })] })]
  const definition = defineActor("code-cancellation", Effect.gen(function* () {
    const node = yield* codeMode({ name: "code" })
    return { atom: Object.assign(node, { schema: Event }), actions: { start: (id: string) => ({ type: "ModelReturned" as const, purpose: "inference" as const, callId: id, text: "", toolCalls: [{ callId: `tool:${id}`, providerId: id, name: "execute", input: { code: "return await test.job({})" } }] }) } }
  }))
  const store = yield* createActorStore({ actor: definition, actorContext: Context.pick(ToolCatalog), services: () => codeModeActs(packages).pipe(Layer.provideMerge(Layer.succeed(Isolate, {
    run: (_input, onCall) => onCall({ ordinal: 0, package: "test", method: "job", input: {} }).pipe(Effect.map(result => ({ result, logs: [] }))),
  }))) })
  yield* Effect.gen(function* () {
    yield* store.methods.start("first")
    yield* Deferred.await(entered)
    const ref = store.snapshot().deferred().find(work => work.request.executor === EvaluateCode.name)!.ref
    yield* store.cancel(ref, options.reason)
    yield* store.wait
    if (store.get(pendingTools).pending !== null || store.snapshot().events.filter(event => event.type === "EffectCancelled").length !== 2 || store.snapshot().events.filter(event => event.type === "ToolReturned").length !== 1 || store.getState().view.executions.length !== 0) return yield* Effect.fail(new RuntimeError("Cancelled code retained running packages or its tool queue"))
    yield* store.methods.start("second")
    yield* store.wait
    if (executions !== 2 || store.get(pendingTools).pending !== null || store.snapshot().events.filter(event => event.type === "ToolReturned").length !== 2) return yield* Effect.fail(new RuntimeError("Cancelled code prevented subsequent execution"))
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(5_000))))
