import type { ToolOffer } from "../src/component/view"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { AGENT_VIEW_ALGEBRA } from "../src/component/view"
import { modelRequest } from "../src/model/request"
import { messages } from "../src/component/messages"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { toolComponent } from "../src/component/tool/machine"
import { testInferenceLayer } from "@clavia/tardigrade-agent/fixtures/model"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { FetchHttpClient } from "effect/unstable/http"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { actor, component, legacyComponent } from "@clavia/tardigrade-core/actor"
import { fetchPackage } from "@clavia/tardigrade-code/package/fetch"
import { infer, type AgentComponent, type AgentView } from "../src/component/infer/index"
import { codeMode } from "../src/component/code/index"
import { budget } from "../src/component/budget/index"
import { compact, compaction } from "../src/component/compact/index"
import { agentMethods } from "../src/actor/methods"
import { tool } from "../src/component/tool/index"
import { nativeOutput } from "../src/component/native-output"
import { receive } from "../src/runtime/turn"
import { NativeOutputSupport, type InferRequest } from "../src/model/contract"


const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const assembled = <R>(component: AgentComponent<R>) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [component]
})

// The component assembly end to end: the render the model sees is the composed view, and a call
// routes through the same derived tool binding.

const memoryLog = (initial: ReadonlyArray<Event> = []) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

const noRouter = Layer.mergeAll(
  Layer.succeed(ThreadAllocator, { allocate: () => Effect.die(new Error("unexpected child allocation")) }),
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
  Layer.succeed(NativeOutputSupport, { withTools: true })
)

const readLog = Effect.flatMap(EventLog, (log) => log.read)
const run = <A, R>(effect: Effect.Effect<A, never, R>, layers: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A>)

const echoTable = tool([
  {
    spec: { name: "echo", description: "echoes", inputSchema: { type: "object" } },
    run: (input) => Effect.succeed({ echoed: input })
  }
])

const viewComponent = (
  name: string,
  view: AgentView | ((log: ReadonlyArray<Event>) => AgentView)
): AgentComponent => legacyComponent({

  name,
  derive: (log) => ({ view: typeof view === "function" ? view(log) : view, transitions: [] })
})

test("a turn without any applicable default durably asks for a model reference", async () => {
    let calls = 0
    const mind = testInferenceLayer( {
      react: () => {
        calls += 1
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], {
      models: {
        allow: [{ provider: "openai", model_ids: ["large", "small"] }]
      }
    }))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "choose" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
      turn: "m1",
      cause: "model_selection",
      attempts: 0
    })
    expect(calls).toBe(0)
  })

test("an actor with no model override inherits the host default", async () => {
    const selected = { provider: "openai", model_id: "small" } as const
    const seen: InferRequest[] = []
    const mind = testInferenceLayer( {
      resolve: (model) => ({
        model: model ?? selected,
        models: {
          default: selected,
          allow: [{ provider: "openai", model_ids: ["large", "small"] }]
        }
      }),
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput]))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "inherit" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(seen.map((request) => request.model)).toEqual([selected])
    const called = events.find((event) => event.type === "ModelCalled")
    expect(called).toMatchObject({ model: selected })
    expect(called).not.toHaveProperty("models")
  })

test("a died attempt retries the model recorded by ModelCalled", async () => {
    const recorded = { provider: "openai", model_id: "small" } as const
    const current = { provider: "openai", model_id: "large" } as const
    const seen: InferRequest[] = []
    const mind = testInferenceLayer( {
      resolve: (model) => ({ model: model ?? current, models: { default: current, allow: "*" } }),
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], { models: { default: current, allow: "*" } }))
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(agent)
        return yield* readLog
      }),
      Layer.mergeAll(
        memoryLog([
          { type: "MessageReceived", id: "m1", text: "retry", at: 1 },
          { type: "ModelCalled", callId: "m1/infer/0", model: recorded, ordinal: 0, turn: "m1", at: 2 }
        ]),
        mind,
        noRouter,
        KeyValueStore.layerMemory
      )
    )
    expect(seen.map((request) => request.model)).toEqual([recorded])
    expect(events.filter((event) => event.type === "ModelCalled").map((event) =>
      (event as { readonly model?: unknown }).model
    )).toEqual([recorded, recorded])
  })

test("a historical model string durably fails its turn", async () => {
    const seen: InferRequest[] = []
    const mind = testInferenceLayer( {
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(agent)
        yield* receive(agent, {
          id: "m2",
          text: "continue",
          model: { provider: "openai", model_id: "gpt-5.6" }
        })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog([{
        type: "MessageReceived",
        id: "m1",
        text: "old",
        model: "gpt-4o",
        at: 1
      }]), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
      turn: "m1",
      cause: "message_invalid",
      attempts: 0
    })
    expect(seen.map((request) => request.model)).toEqual([
      { provider: "openai", model_id: "gpt-5.6" }
    ])
    expect(events.at(-1)?.type).toBe("TurnCompleted")
  })

test("each turn can select a provider without losing its conversation", async () => {
    const seen: InferRequest[] = []
    const mind = testInferenceLayer( {
      resolve: (model) => ({ model: model!, contextWindowTokens: model?.provider === "vercel" ? 200_000 : 100_000 }),
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer(
      [
            compaction(),
      nativeOutput
    ], {
      models: {
        default: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" },
        allow: "*"
      }
    }))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, {
          id: "m1",
          text: "first",
          model: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" }
        })
        yield* receive(agent, {
          id: "m2",
          text: "second",
          model: { provider: "openai", model_id: "gpt-5.6" }
        })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(seen.map((request) => request.model)).toEqual([
      { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" },
      { provider: "openai", model_id: "gpt-5.6" }
    ])
    expect(seen[0]?.context?.contextWindowTokens).toBe(200_000)
    expect(seen[1]?.context?.contextWindowTokens).toBe(100_000)
    expect(seen[1]?.trajectory.filter((event) => event.type === "MessageReceived").map((event) =>
      (event as { readonly id?: unknown }).id
    )).toEqual(["m1", "m2"])
    expect(events.filter((event) => event.type === "ModelCalled")).toMatchObject([
      { turn: "m1", model: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" } },
      { turn: "m2", model: { provider: "openai", model_id: "gpt-5.6" } }
    ])
  })

test("the render is the composed output, and the request carries it to the model", async () => {
    const seen: InferRequest[] = []
    const mind = testInferenceLayer( {
      react: (request: InferRequest) => {
        seen.push(request)
        const returned = request.trajectory.some((e) => e.type === "ToolReturned")
        return Effect.succeed(
          returned
            ? { kind: "complete" as const, output: "done" }
            : { kind: "calls" as const, calls: [{ callId: "c1", name: "echo", arguments: { hi: 1 } }] as const }
        )
      }
    })
    const agent = assembled(infer([budget(echoTable, {
      onExhausted: (reason, settle) => settle({ error: reason }),
      usage: (observation) => observation.calls.length,
      rejectionMessage: "Tool budget reached. Answer now with your best result.",
      view: (view, state) =>
        state.phase === "spending"
          ? view
          : {
              ...view,
              tools: [],
              system: [...view.system, "Your tool budget is spent. Answer now with what you have."]
            }
    }), compaction({ model: TEST_MODEL.models.default }), nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    // The model was shown exactly what the components derived.
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect(seen[0]!.system).toContain("echo")
    // The call routed through the table component's tool binding and settled.
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({ callId: "c1", result: { echoed: { hi: 1 } } })
    expect(events.at(-1)?.type).toBe("TurnCompleted")
  })

test("a call outside the derived tools answers unknown-tool naming the composed tools", async () => {
    const mind = testInferenceLayer( {
      react: (request: InferRequest) => {
        const returned = request.trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
        return Effect.succeed(
          returned === undefined
            ? { kind: "calls" as const, calls: [{ callId: "c9", name: "ghost", arguments: {} }] as const }
            : { kind: "complete" as const, output: JSON.stringify(returned.result) }
        )
      }
    })
    const agent = assembled(infer([echoTable, nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({
      result: { error: "unknown tool: ghost. Call one of: echo." }
    })
  })

test("a direct package call teaches the execute calling convention", async () => {
    const mind = testInferenceLayer( {
      react: (request: InferRequest) => {
        const returned = request.trajectory.find((event) => event.type === "ToolReturned") as { result?: unknown } | undefined
        return Effect.succeed(
          returned === undefined
            ? { kind: "calls" as const, calls: [{ callId: "c10", name: "fetch.get", arguments: { url: "https://example.com" } }] as const }
            : { kind: "complete" as const, output: JSON.stringify(returned.result) }
        )
      }
    })
    const agent = assembled(infer([codeMode([fetchPackage()]), nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory, FetchHttpClient.layer)
    )
    expect(events.find((event) => event.type === "ToolReturned")).toMatchObject({
      result: {
        error: "unknown tool: fetch.get. Package methods run inside execute. Call execute with JavaScript such as `return await fetch.get({...})`."
      }
    })
  })

test("a tool remains routable from the view that offered its call", async () => {
    const offer: ToolOffer = { spec: { name: "once", description: "one call", inputSchema: {} }, serve: (_call, _log, answer) => [answer("served")] }
    const ephemeral = toolComponent(component({ name: "ephemeral", initial: () => false,
      step: (hidden, event) => hidden || event.type === "ToolCalled",
      output: hidden => ({ view: { ...AGENT_VIEW_ALGEBRA.empty, tools: hidden ? [] : [{ spec: offer.spec }] }, transitions: [], interactions: { tools: () => hidden ? [] : [offer] } })
    }))
    const mind = testInferenceLayer( {
      react: (request: InferRequest) => Effect.succeed(
        request.trajectory.some((event) => event.type === "ToolReturned")
          ? { kind: "complete" as const, output: "done" }
          : { kind: "calls" as const, calls: [{ callId: "once-1", name: "once", arguments: {} }] as const }
      )
    })
    const events = await run(
      Effect.gen(function* () {
        yield* receive(assembled(infer([ephemeral, nativeOutput], TEST_MODEL)), { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )

    expect(events.find((event) => event.type === "ToolReturned")).toMatchObject({ result: "served" })
  })

test("unrelated interactions are never invoked by infer", async () => {
    let invoked = false
    const unrelated = component({ name: "unrelated", initial: () => undefined, step: state => state,
      output: () => ({ view: AGENT_VIEW_ALGEBRA.empty, interactions: { prepare: () => { invoked = true; throw new Error("unrelated") } }, transitions: [] }) })
    const mind = testInferenceLayer({ react: () => Effect.succeed({ kind: "complete", output: "done" }) })
    const events = await run(Effect.gen(function* () {
      yield* receive(assembled(infer([unrelated, nativeOutput], TEST_MODEL)), { id: "m", text: "go" })
      return yield* readLog
    }), Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory))
    expect(invoked).toBe(false)
    expect(events.some(event => event.type === "TurnCompleted")).toBe(true)
  })

test("a message view appearing after initialization replaces the fallback", async () => {
    const dynamic = viewComponent("dynamic", log => log.length === 0 ? AGENT_VIEW_ALGEBRA.empty : {
      ...AGENT_VIEW_ALGEBRA.empty, messages: [{ component: "dynamic", trajectory: [{ type: "MessageReceived", id: "custom", text: "custom conversation" }], context: {}, ready: true }]
    })
    let content: unknown
    const mind = testInferenceLayer({ react: request => {
      content = modelRequest(request.trajectory, request, request.context).messages[0]?.content
      return Effect.succeed({ kind: "complete", output: "done" })
    } })
    await run(receive(assembled(infer([dynamic, nativeOutput], TEST_MODEL)), { id: "m", text: "go" }), Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory))
    expect(content).toBe("custom conversation")
  })

test("an outer wrapper can withhold compaction work and inference waits", async () => {
    const child = compact(messages(), {})
    const blocked = component({
      name: "blocked", children: child, initial: () => undefined, step: state => state,
      output: (_state, child) => ({ ...child.output(), transitions: [] })
    })
    let calls = 0
    const mind = testInferenceLayer({ resolve: model => ({ model: model!, contextWindowTokens: 100 }), react: () => { calls++; return Effect.succeed({ kind: "complete", output: "unexpected" }) } })
    const initial: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "old", text: "x".repeat(2000), at: 1 },
      { type: "TurnCompleted", turn: "old", output: "done", at: 2 }
    ]
    const events = await run(Effect.gen(function* () {
      yield* receive(assembled(infer([blocked, nativeOutput], TEST_MODEL)), { id: "next", text: "continue" })
      return yield* readLog
    }), Layer.mergeAll(memoryLog(initial), mind, noRouter, KeyValueStore.layerMemory))
    expect(calls).toBe(0)
    expect(events.some(event => event.type === "CompactionCompleted")).toBe(false)
    expect(events.some(event => event.type === "ModelCalled")).toBe(false)
  })

test.each([false, true])("model execution uses the committed child snapshot (child proposes work: %s)", async proposesWork => {
  const child = component({
    name: "on-message-received",
    initial: (): { context?: ReturnType<typeof bindTransitionContext>; settled: boolean; started: boolean } => ({ settled: false, started: false }),
    step: (state, event, context) => event.type === "MessageReceived" ? { context, settled: false, started: false }
      : event.type === "ModelCalled" ? { ...state, started: true }
      : event.type === "RequestObserved" ? { ...state, settled: true } : state,
    output: state => ({
      view: { ...AGENT_VIEW_ALGEBRA.empty,
        system: [state.started ? "after execution started" : state.context === undefined ? "before message" : "after message"],
        context: [{ component: "on-message-received", policy: { messageRenderCap: state.started ? 33 : state.context === undefined ? 5 : 99 } }]
      },
      transitions: !proposesWork || state.context === undefined || state.settled ? []
        : [state.context.intent("record", { type: "RequestObserved" })]
    })
  })
  let requests = 0
  const mind = testInferenceLayer({ react: request => {
    requests++
    expect(request.system).toBe("after message")
    expect(request.context?.messageRenderCap).toBe(99)
    if (proposesWork) expect(request.trajectory.some(event => event.type === "RequestObserved")).toBe(true)
    return Effect.succeed({ kind: "complete", output: "done" })
  } })
  const events = await run(Effect.gen(function* () {
    yield* receive(assembled(infer([child, nativeOutput], TEST_MODEL)), { id: "m", text: "go" })
    return yield* readLog
  }), Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory))
  expect(requests).toBe(1)
  expect(events.filter(event => event.type === "ModelCalled")).toHaveLength(1)
  expect(events.some(event => event.type === "TurnCompleted")).toBe(true)
  const finalView = replayProjection(machineOf(child), events).view
  expect(finalView.system).toEqual(["after execution started"])
  expect(finalView.context[0]?.policy.messageRenderCap).toBe(33)
})

test("blocking inference records no attempt and restart can execute it", async () => {
  const child = infer([nativeOutput], TEST_MODEL)
  const blocked = component({
    name: "block-inference", children: child, initial: () => undefined, step: state => state,
    output: (_state, child) => ({ ...child.output(), transitions: child.output().transitions.filter(transition => !transition.key.endsWith(',"infer"]')) })
  })
  let calls = 0
  const mind = testInferenceLayer({ react: () => { calls++; return Effect.succeed({ kind: "complete", output: "done" }) } })
  const pending = await run(Effect.gen(function* () {
    yield* receive(assembled(blocked), { id: "m", text: "go" })
    return yield* readLog
  }), Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory))
  expect(calls).toBe(0)
  expect(pending.filter(event => event.type === "ModelCalled")).toHaveLength(0)
  const resumed = await run(Effect.gen(function* () {
    yield* settleActor(assembled(child))
    return yield* readLog
  }), Layer.mergeAll(memoryLog(pending), mind, noRouter, KeyValueStore.layerMemory))
  expect(calls).toBe(1)
  expect(resumed.filter(event => event.type === "ModelCalled")).toHaveLength(1)
  expect(resumed.filter(event => event.type === "TurnCompleted")).toHaveLength(1)
})

test.each([1, 2])("model requests stop after %s interrupted executions across restarts", async (giveUpAfter) => {
  let calls = 0
  const keys: Array<string | undefined> = []
  let saved: ReadonlyArray<Event> = []
  let crashSnapshot: ReadonlyArray<Event> | undefined
  for (let restart = 0; restart <= giveUpAfter; restart++) {
    crashSnapshot = undefined
    const definition = assembled(infer([nativeOutput], { ...TEST_MODEL, giveUpAfter }))
    const events = await run(Effect.gen(function* () {
      const log = yield* EventLog
      const mind = testInferenceLayer({ react: (_request, key) => Effect.gen(function* () {
        calls++
        keys.push(key)
        crashSnapshot = JSON.parse(JSON.stringify(yield* log.read)) as ReadonlyArray<Event>
        return yield* Effect.interrupt
      }) })
      yield* Effect.exit(restart === 0
        ? receive(definition, { id: "m", text: "go" })
        : settleActor(definition)).pipe(Effect.provide(mind))
      return yield* readLog
    }), Layer.mergeAll(memoryLog(saved), noRouter, KeyValueStore.layerMemory))
    saved = crashSnapshot ?? JSON.parse(JSON.stringify(events)) as ReadonlyArray<Event>
  }

  expect(calls).toBe(giveUpAfter)
  expect(keys).toEqual(Array.from({ length: giveUpAfter }, () => "m/infer/0"))
  expect(saved.filter(event => event.type === "ModelCalled").map(event => event.ordinal))
    .toEqual(Array.from({ length: giveUpAfter }, (_, index) => index))
  expect(saved.filter(event => event.type === "ModelReturned")).toHaveLength(0)
  expect(saved.filter(event => event.type === "TurnCompleted")).toHaveLength(0)
  expect(saved.filter(event => event.type === "TurnFailed")).toMatchObject([{
    turn: "m",
    cause: "inference_attempts_exhausted",
    attempts: giveUpAfter,
    policy: { giveUpAfter }
  }])
})

test("a wrapper around infer can withhold the selected compaction proposal", async () => {
  const lock = Layer.succeed(ModelLock, modelLockService(modelLockOf({
    schema: 2,
    providers: { test: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: ["FIXTURE_KEY"] } },
    models: [{ provider: "test", model_id: "test-model", contextWindowTokens: 100 }]
  }), TEST_MODEL.models))
  const child = infer([compact(messages()), nativeOutput], TEST_MODEL)
  const seen = new Set<string>()
  const governed = component({
    name: "govern-infer", children: child,
    initial: () => undefined, step: state => state,
    output: (_state, child) => {
      const output = child.output()
      const compactions = new Set(output.view.messages?.flatMap(message => message.compaction?.proposals ?? []))
      for (const proposal of output.transitions) if (compactions.has(proposal.key)) seen.add(proposal.key)
      return { ...output, transitions: output.transitions.filter(proposal => !compactions.has(proposal.key)) }
    }
  })
  let calls = 0
  const mind = testInferenceLayer({ react: () => {
    calls++
    return Effect.succeed({ kind: "complete", output: "unexpected" })
  } })
  const initial: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "old", text: "x".repeat(2000), at: 1 },
    { type: "TurnCompleted", turn: "old", output: "done", at: 2 }
  ]
  const events = await run(Effect.gen(function* () {
    yield* receive(assembled(governed), { id: "next", text: "continue" })
    return yield* readLog
  }), Layer.mergeAll(memoryLog(initial), mind, noRouter, KeyValueStore.layerMemory, lock))
  expect(seen.size).toBe(1)
  expect(calls).toBe(0)
  expect(events.some(event => event.type === "CompactionCompleted" || event.type === "ModelCalled")).toBe(false)
})
