import { Context, Deferred, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { defineActor, durablePromise, effectKey, EffectExecution, RuntimeError, type ActorRuntime, type EffectRef, type Journal, type Recorded } from "@clavia/tardigrade-experimental-core"
import { createActorStore, Promises } from "@clavia/tardigrade-experimental-host"
import { definePackage, promiseTool, tool } from "@clavia/tardigrade-experimental-packages"
import { packageTools } from "@clavia/tardigrade-experimental-agent/atoms/tools"
import { ToolCatalog } from "@clavia/tardigrade-experimental-agent/context"
import { Event } from "@clavia/tardigrade-experimental-agent/event"
import { toolActs } from "@clavia/tardigrade-experimental-agent/services/tools"

const cases = fc.record({ executor: fc.constantFrom("local" as const, "remote" as const), value: fc.integer(), rejected: fc.boolean(), extraReopens: fc.integer({ min: 0, max: 2 }) })

// toolDeferredLifecycle checks tool handles return before completion and survive reopening with one final inbox result.
export const toolDeferredLifecycle = fc.asyncProperty(cases, options => Effect.runPromise(Effect.gen(function* () {
  const recorded = yield* Deferred.make<void>()
  const blocked = yield* Deferred.make<void>()
  const records: Recorded<Event>[] = []
  const payloads = () => records.map(record => record.event)
  const executions: EffectRef[] = []
  let reopening = false
  let watches = 0
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires undefined; Effect.void has a void result type.
    readCheckpoint: Effect.succeed(undefined),
    append: (expected, events) => Effect.gen(function* () {
      if (expected !== records.length) return yield* Effect.fail(new RuntimeError("Unexpected journal length"))
      records.push(...events)
      if (events.some(({ event }) => event.type === "ToolReturned")) yield* Deferred.succeed(recorded, undefined)
    }),
    appendWithCheckpoint: () => Effect.fail(new RuntimeError("Unexpected checkpoint")),
  }
  const input = Schema.Struct({ value: Schema.Finite })
  const method = options.executor === "local" ? tool({ name: "job", description: "Local job", input, execution: "async", run: value => Effect.gen(function* () {
    const current = yield* EffectExecution
    executions.push(current.ref)
    if (!reopening) yield* Deferred.await(blocked)
    if (options.rejected) return yield* Effect.fail(new RuntimeError("Job failed"))
    return value.value
  }) }) : promiseTool({ name: "job", description: "Remote job", input, submit: () => Effect.gen(function* () {
    executions.push((yield* EffectExecution).ref)
    return { executor: "remote", id: "job" }
  }) })
  const packages = [definePackage({ name: "test", description: "Jobs", methods: [method] })]
  const actor = defineActor("tool-recovery", Effect.gen(function* () {
    const tools = yield* packageTools
    return { atom: Object.assign(tools, { schema: Event }), actions: {
      start: () => ({ type: "ModelReturned" as const, purpose: "inference" as const, callId: "model", text: "", toolCalls: [{ callId: "job", providerId: "provider", name: "test__job", input: { value: options.value } }] }),
      barrier: () => ({ type: "MessageReceived" as const, kind: "message" as const, turnId: "barrier", text: "" }),
    } }
  }))
  const open = () => createActorStore({ actor, journal, checkpoint: { mode: "manual" }, promiseDelivery: { retryIntervalMs: 1 },
    actorContext: services => Context.make(ToolCatalog, Context.get(services, ToolCatalog)),
    services: (host: ActorRuntime<Event>) => Layer.merge(toolActs(packages), Layer.succeed(Promises, {
      watch: registration => Effect.gen(function* () {
        watches++
        if (options.executor === "local") return yield* Effect.fail(new RuntimeError("Local tool delegated to resolver"))
        if (!reopening) return
        const promise = durablePromise(registration.ref, { success: Schema.Json, error: Schema.String })
        yield* host.send([options.rejected ? promise.fail("Job failed") : promise.succeed(options.value)])
      }), cancel: () => Effect.void,
    })),
  })
  const first = yield* open()
  yield* Effect.gen(function* () {
    yield* first.methods.start()
    yield* Deferred.await(recorded)
    yield* first.methods.barrier()
    const returned = payloads().find(event => event.type === "ToolReturned")
    const settled = payloads().find(event => event.type === "EffectSettled")
    if (!returned || returned.type !== "ToolReturned" || !returned.promise || !settled || settled.type !== "EffectSettled" || settled.outcome.status !== "fulfilled" || !Schema.is(Schema.Struct({ type: Schema.Literal("promise") }))(settled.outcome.value)) return yield* Effect.fail(new RuntimeError("Tool handle bypassed core deferred execution"))
    if (payloads().some(event => event.type === "PromiseSettled") || effectKey(returned.promise.ref) !== effectKey(executions[0]!) || returned.promise.handle.executor !== options.executor) return yield* Effect.fail(new RuntimeError("Tool did not return its pending handle immediately"))
  }).pipe(Effect.ensuring(first.close))
  reopening = true
  for (let cycle = 0; cycle <= options.extraReopens; cycle++) {
    const restored = yield* open()
    yield* Effect.gen(function* () {
      yield* restored.wait
      const replies = payloads().filter(event => event.type === "MessageReceived" && event.kind === "message" && event.turnId === "promise:job")
      if (executions.length !== (options.executor === "local" ? 2 : 1) || payloads().filter(event => event.type === "ToolReturned").length !== 1 || payloads().filter(event => event.type === "EffectRequested").length !== 1 || payloads().filter(event => event.type === "EffectSettled").length !== 1 || payloads().filter(event => event.type === "PromiseSettled").length !== 1 || replies.length !== 1) return yield* Effect.fail(new RuntimeError("Tool recovery duplicated or lost lifecycle delivery"))
      if (executions.some(ref => effectKey(ref) !== effectKey(executions[0]!)) || (options.executor === "local" ? watches !== 0 : watches !== 2)) return yield* Effect.fail(new RuntimeError("Tool recovery changed execution ownership or identity"))
      const reply = replies[0]!
      if (reply.type !== "MessageReceived" || reply.kind !== "message") return yield* Effect.fail(new RuntimeError("Expected tool inbox result"))
      const data: unknown = JSON.parse(reply.text.slice("Tool promise result (data): ".length))
      const expected = options.rejected ? Schema.Struct({ result: Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.String }) }) : Schema.Struct({ result: Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.Literal(options.value) }) })
      if (!Schema.is(expected)(data)) return yield* Effect.fail(new RuntimeError("Tool inbox result changed on recovery"))
    }).pipe(Effect.ensuring(restored.close))
  }
}).pipe(Effect.scoped, Effect.timeout(5_000))))
