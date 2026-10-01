import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { defineActor, atom, Isolate, RuntimeError, type CoreEvent } from "@clavia/tardigrade-experimental-core"
import { createActorStore, Promises } from "@clavia/tardigrade-experimental-core"
import { infer } from "@clavia/tardigrade-experimental-agent/atoms/infer"
import { codeMode } from "@clavia/tardigrade-experimental-agent/atoms/code-mode"
import { pendingTools, packageTools, withPermissions, withBudget } from "@clavia/tardigrade-experimental-agent/atoms/tools"
import { permissions } from "@clavia/tardigrade-experimental-agent/atoms/permission-request"
import { toolBudget } from "@clavia/tardigrade-experimental-agent/atoms/budget-request"
import { Generate, Summarize, ExecuteTool, AskPermission, AskBudget } from "@clavia/tardigrade-experimental-agent/acts"
import { message, cancel, type Event as AgentEvent } from "@clavia/tardigrade-experimental-agent/event"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-experimental-agent/context"
import { createActor } from "@clavia/tardigrade-experimental-agent"
import { codeModeActs } from "@clavia/tardigrade-experimental-agent/services/code-mode"
import { Event, EvaluateCode } from "@clavia/tardigrade-experimental-agent/code-mode/contracts"
import { definePackage, tool } from "@clavia/tardigrade-experimental-packages"

// compactionCancellationRecovery checks next-turn progress after stopping a real compaction projection.
export const compactionCancellationRecovery = fc.asyncProperty(fc.record({ reason: fc.string({ maxLength: 20 }), reopen: fc.boolean(), queued: fc.boolean() }), options => Effect.runPromise(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  let summaries = 0
  const model = { provider: "openrouter" as const, model_id: "test" }
  const history: AgentEvent[] = [
    { type: "MessageReceived", kind: "message", turnId: "previous", text: "x".repeat(500) },
    { type: "ModelCalled", purpose: "inference", turnId: "previous", callId: "model:previous:0", model, contextWindowTokens: 128 },
    { type: "ModelReturned", purpose: "inference", callId: "model:previous:0", text: "done", toolCalls: [] },
    { type: "TurnSettled", turnId: "previous", outcome: "completed", callId: "model:previous:0" },
  ]
  const open = (events: readonly (AgentEvent | CoreEvent)[]) => createActorStore({ actor: createActor, events, actorContext: Context.pick(ModelInfo, ToolCatalog), services: () => Layer.mergeAll(
    Layer.succeed(ModelInfo, { model, contextWindowTokens: 128 }), Layer.succeed(ToolCatalog, { names: [], specs: [] }),
    Generate.layer(() => Effect.succeed(Generate.defer({ executor: "remote", id: "model" }))),
    Summarize.layer(() => Effect.gen(function* () {
      summaries++
      if (summaries === 1) { yield* Deferred.succeed(entered, undefined); return yield* Effect.never }
      return { text: "summary", toolCalls: [] }
    })),
    ExecuteTool.layer(() => Effect.succeed(null)), AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "allowed" })),
    Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
  ) })
  let store = yield* open(history)
  yield* Effect.gen(function* () {
    yield* store.actions.message({ text: "first", turnId: "first" })
    yield* Deferred.await(entered)
    if (options.queued) yield* store.actions.message({ text: "second", turnId: "second" })
    yield* store.actions.cancel({ turnId: "first", reason: options.reason })
    yield* store.wait
    if (options.reopen) {
      const events = store.snapshot().events
      yield* store.close
      store = yield* open(events)
    }
    if (!options.queued) yield* store.actions.message({ text: "second", turnId: "second" })
    yield* store.wait
    if (!store.snapshot().events.some(event => event.type === "ModelCalled" && event.purpose === "inference" && event.turnId === "second")) return yield* Effect.fail(new RuntimeError("Cancelled compaction prevented the next turn"))
  }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
}).pipe(Effect.scoped, Effect.timeout(5_000))))

// agentTurnCancellation checks acceptanceFenced, settlementSound, and cancellationProgress from core/quint/actorCancellation.qnt.
export const agentTurnCancellation = fc.asyncProperty(fc.record({
  phase: fc.constantFrom("model", "tool", "permission", "budget", "deferred"),
  reason: fc.string({ maxLength: 20 }), calls: fc.integer({ min: 1, max: 4 }), duplicates: fc.integer({ min: 0, max: 2 }), reopen: fc.boolean(), completionRace: fc.boolean(),
}), options => Effect.runPromise(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  let generated = 0
  const definition = defineActor("turn-cancellation", Effect.gen(function* () {
    const available = yield* packageTools
    const governed = withPermissions(available, permissions(pendingTools, { policy: { default: options.phase === "permission" ? "ask" : "allow", actions: {} } }))
    const tools = withBudget(governed, toolBudget(pendingTools, { maxCalls: options.phase === "budget" ? 0 : options.calls, requestTool: "request_budget" }))
    const node = yield* infer(atom(get => ({ system: "", tools: get(tools), context: { view: { position: "ready" as const, messages: [] }, events: {}, acts: {} } })))
    return { atom: node, actions: { message, cancel } }
  }))
  const open = (events?: readonly (AgentEvent | CoreEvent)[]) => createActorStore({
    actor: definition, ...(events ? { events } : {}), actorContext: Context.pick(ModelInfo, ToolCatalog),
    services: () => Layer.mergeAll(
      Layer.succeed(ModelInfo, { model: { provider: "openrouter", model_id: "test" }, contextWindowTokens: 10_000 }),
      Layer.succeed(ToolCatalog, { names: ["test.job", "request_budget"], specs: [] }),
      Generate.layer(() => Effect.gen(function* () {
        generated++
        if (options.phase === "model" || generated > 1) {
          yield* Deferred.succeed(entered, undefined)
          return Generate.defer({ executor: "remote", id: `model:${generated}` })
        }
        return { text: "", toolCalls: Array.from({ length: options.calls }, (_, index) => ({ callId: `tool:${index}`, name: options.phase === "budget" ? "request_budget" : "test.job", input: options.phase === "budget" ? { amount: 1, reason: "more" } : {} })) }
      })),
      Summarize.layer(() => Effect.succeed({ text: "summary", toolCalls: [] })),
      ExecuteTool.layer(() => Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        if (options.phase === "deferred") return ExecuteTool.defer({ executor: "remote", id: "tool" })
        return yield* Effect.never
      })),
      AskPermission.layer(() => Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        return AskPermission.defer({ executor: "remote", id: "permission" })
      })),
      AskBudget.layer(() => Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        return AskBudget.defer({ executor: "remote", id: "budget" })
      })),
      Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
    ),
  })
  let store = yield* open()
  yield* Effect.gen(function* () {
    yield* store.actions.cancel({ turnId: "idle", reason: "idle" })
    yield* store.wait
    if (store.snapshot().events.some(event => event.type === "TurnSettled")) return yield* Effect.fail(new RuntimeError("Idle cancellation settled a turn"))
    yield* store.actions.message({ text: "hello", turnId: "first" })
    yield* Deferred.await(entered)
    if (options.phase !== "tool") yield* store.wait
    const deferred = store.snapshot().deferred().find(work => work.request.executor === ExecuteTool.name)
    yield* store.actions.cancel({ turnId: "first", reason: options.reason })
    if (options.reopen || (options.phase === "deferred" && options.completionRace)) {
      const events = store.snapshot().events
      const started = events.findIndex(event => event.type === "MessageReceived")
      const boundary = events.findIndex((event, index) => event.type === "AbortReceived" && index > started)
      const prefix = [...events.slice(0, boundary + 1), ...(options.completionRace && deferred ? [{ type: "PromiseSettled" as const, ref: deferred.ref, result: { status: "fulfilled" as const, value: null } }] : [])]
      yield* store.close
      store = yield* open(prefix)
    }
    yield* store.wait
    for (let index = 0; index < options.duplicates; index++) yield* store.actions.cancel({ turnId: "first", reason: "duplicate" })
    yield* store.wait
    const events = store.snapshot().events
    const terminal = events.filter(event => event.type === "TurnSettled")
    if (terminal.length !== 1 || terminal[0]!.outcome !== "cancelled" || terminal[0]!.reason !== options.reason || store.getState().view.position !== "idle" || store.get(pendingTools).queue.length) return yield* Effect.fail(new RuntimeError("Turn cancellation failed to drain and settle once"))
    const started = events.findIndex(event => event.type === "MessageReceived")
    const boundary = events.findIndex((event, index) => event.type === "AbortReceived" && index > started)
    if (events.slice(boundary + 1).some(event => event.type === "EffectRequested")) return yield* Effect.fail(new RuntimeError("Stopped turn accepted new work"))
    const calls = events.filter(event => event.type === "ModelCalled").length
    yield* store.actions.message({ text: "next", turnId: "second" })
    yield* store.wait
    if (store.snapshot().events.filter(event => event.type === "ModelCalled").length !== calls + 1) return yield* Effect.fail(new RuntimeError("Stopped actor could not accept the next turn"))
  }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
}).pipe(Effect.scoped, Effect.timeout(5_000))))

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
    yield* store.actions.message("first")
    yield* store.wait
    const ref = store.snapshot().deferred()[0]!.ref
    for (let index = 0; index <= options.duplicates; index++) yield* store.cancel(ref, options.reason)
    yield* store.wait
    if (store.getState().view.position !== "idle" || store.snapshot().events.filter(event => event.type === "TurnSettled").length !== 1) return yield* Effect.fail(new RuntimeError("Cancellation stranded the active agent turn"))
    yield* store.actions.message("second")
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
    yield* store.actions.start("first")
    yield* Deferred.await(entered)
    const ref = store.snapshot().deferred().find(work => work.request.executor === EvaluateCode.name)!.ref
    yield* store.cancel(ref, options.reason)
    yield* store.wait
    if (store.get(pendingTools).pending !== null || store.snapshot().events.filter(event => event.type === "EffectCancelled").length !== 2 || store.snapshot().events.filter(event => event.type === "ToolReturned").length !== 1 || store.getState().view.executions.length !== 0) return yield* Effect.fail(new RuntimeError("Cancelled code retained running packages or its tool queue"))
    yield* store.actions.start("second")
    yield* store.wait
    if (executions !== 2 || store.get(pendingTools).pending !== null || store.snapshot().events.filter(event => event.type === "ToolReturned").length !== 2) return yield* Effect.fail(new RuntimeError("Cancelled code prevented subsequent execution"))
  }).pipe(Effect.ensuring(store.close))
}).pipe(Effect.scoped, Effect.timeout(5_000))))
