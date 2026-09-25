import * as fc from "fast-check"
import { BindingInvocation } from "../src/model/execution/settings"
import { testInferenceLayer } from "@clavia/tardigrade-agent/testing/model"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actor } from "@clavia/tardigrade-core/actor"
import { infer, type AgentComponent } from "../src/component/infer"
import { agentMethods } from "../src/actor/methods"
import { nativeOutput } from "../src/component/native-output"
import { receive } from "../src/runtime/turn"
import { NativeOutputSupport } from "../src/model/contract"

import { testModelData } from "@clavia/tardigrade-agent/testing/model"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { testModelLock } from "@clavia/tardigrade-agent/testing/model"
import { messages } from "../src/component/messages"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { testMachineOf as machineOf } from "../fixtures/component"
import { LanguageModel, Response, type Prompt } from "effect/unstable/ai"
import { KeyValueStore } from "effect/unstable/persistence"
import { ObjectStorage } from "../src/object/storage"
import { objectStorageFromKeyValueStore } from "../src/object/key-value"
import type { MessageContent } from "../src/log/message"
import { CurrentModel } from "@clavia/tardigrade-model/settings"
import type { ModelRef } from "@clavia/tardigrade-model/reference"
import { unknownModelError } from "@clavia/tardigrade-model/error"
import { renderMessages } from "../src/projection/messages"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { actorFromProjections, Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { completeTransitionProjection } from "@clavia/tardigrade-core/transition"

import { composeKeys } from "@clavia/tardigrade-core/log"
import { messageKeys } from "@clavia/tardigrade-core/interaction/provider-message"
import { agentKeys, type Action } from "../src/log/events"

const summaryLayer = (respond: (prompt: string, model: ModelRef | undefined, native: Prompt.Prompt) => Effect.Effect<Action>) => Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: () => Effect.die("Use streaming in this fixture"),
  streamText: request => Stream.unwrap(Effect.gen(function* () {
    const model = yield* CurrentModel
    const prompt = request.prompt.content.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")
    const action = yield* respond(prompt, model, request.prompt)
    if (action.kind === "fail") return Stream.fail(unknownModelError(action.error))
    const text = action.kind === "complete" ? action.output : action.text ?? ""
    const parts: Response.StreamPartEncoded[] = [Response.makePart("text-start", { id: "summary" }), Response.makePart("text-delta", { id: "summary", delta: text }), Response.makePart("text-end", { id: "summary" })]
    if (action.kind === "calls") for (const call of action.calls) parts.push(Response.makePart("tool-call", { id: call.callId, name: call.name, params: call.arguments, providerExecuted: false }))
    parts.push(Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }))
    return Stream.fromIterable(parts)
  }))
}))

const agentActorKeys = composeKeys(messageKeys, agentKeys)
import {
  compact,
  checkpointOf,
  compactionReactor,
  contextPolicyOf,
  estimateTokens,
  keepFromIndex,
  suffixOf,
  type CompactionPolicy
} from "../src/component/compact/index"

const head: Event = { type: "MessageReceived", id: "m0", text: "extract the covenants", at: 0 }
const TEST_POLICY = { contextWindowTokens: 20_000, fireRatio: 0.8, keepRatio: 0.2 }
const TEST_CONTEXT = contextPolicyOf(TEST_POLICY, TEST_POLICY.contextWindowTokens)
const reactor = compactionReactor(TEST_POLICY, testModelLock())

// One resolved tool round inside the open turn, sized so a dozen rounds cross the token budget.
const round = (i: number, turn = "m0", position = i * 2): Event[] => [
  { type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: { code: `run ${i}` }, turn, at: i * 2 + 1 },
  { type: "ToolReturned", transitionRef: { seq: position, component: "tools", tag: "answer" }, callId: `c${i}`, result: { data: "x".repeat(5_000) }, turn, at: i * 2 + 2 }
]

const openTurn = (rounds: number): Event[] => {
  const log: Event[] = [head]
  for (let i = 1; i <= rounds; i++) log.push(...round(i))
  return log
}

describe("the compaction pass", () => {
  const run = async (initial: ReadonlyArray<Event>, policy: Partial<CompactionPolicy> & { contextWindowTokens: number } = TEST_POLICY, outcome: Action = { kind: "complete", output: "covenants 1 through 13 extracted" }, storage?: typeof ObjectStorage.Service) => {
    const ref = Ref.makeUnsafe<ReadonlyArray<Event>>(initial)
    let briefed = ""
    let nativePrompt: Prompt.Prompt | undefined
    const actor = actorFromProjections<import("effect/unstable/ai").LanguageModel.LanguageModel | ModelLock | EventLog | Self>({
      transitions: [completeTransitionProjection(() => replayProjection(machineOf(compact(messages(), policy)), initial, testModelData).transitions)],
      keyOf: agentActorKeys
    })
    const layers = Layer.mergeAll(
      Layer.succeed(ModelLock, testModelLock()),
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
          read: Ref.get(ref)
        })
      ),
      summaryLayer((prompt, _model, native) => {
          nativePrompt = native
          briefed = prompt
          return Effect.succeed(outcome)
      }),
      Layer.succeed(Self, { actor: "test", instance: "main", thread: "compaction" }),
      storage === undefined ? Layer.empty : Layer.succeed(ObjectStorage, storage)
    )
    const exit = await Effect.runPromiseExit(
      settleActor(actor).pipe(Effect.provide(layers)) as Effect.Effect<void>
    )
    return { log: await Effect.runPromise(Ref.get(ref)), exit, briefed: () => briefed, nativePrompt }
  }

  for (const completed of [false, true]) {
    test(`summarizer reads attachments before the checkpoint (completed turn: ${completed})`, async () => {
      const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(
        objectStorageFromKeyValueStore().pipe(Layer.provide(KeyValueStore.layerMemory))
      )))
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const object = await Effect.runPromise(storage.put(bytes))
      const content: MessageContent = [
        { type: "text", text: "Before image" },
        { type: "file", mediaType: "image/png", filename: "chart.png", object },
        { type: "text", text: "After image" }
      ]
      const initial: Event[] = [
        { type: "MessageReceived", id: "m0", content, at: 0 }, ...openTurn(16).slice(1),
        ...(completed ? [
          { type: "TurnCompleted", turn: "m0", output: "finished", at: 99 },
          { type: "MessageReceived", id: "m1", text: "next task", at: 100 }
        ] : [])
      ]
      const result = await run(initial, TEST_POLICY, undefined, storage)
      expect(result.exit._tag).toBe("Success")
      const parts = result.nativePrompt?.content.flatMap<Prompt.Part>(message => typeof message.content === "string" ? [] : message.content) ?? []
      const imageIndex = parts.findIndex(part => part.type === "file")
      expect(imageIndex).toBeGreaterThan(0)
      expect(parts[imageIndex - 1]).toMatchObject({ type: "text", text: "Before image" })
      expect(parts[imageIndex]).toMatchObject({ type: "file", mediaType: "image/png", fileName: "chart.png", data: bytes })
      expect(parts[imageIndex + 1]).toMatchObject({ type: "text", text: "After image" })
      const activeFiles = renderMessages(result.log).flatMap(message =>
        message.role === "user" && typeof message.content !== "string"
          ? message.content.filter(part => part.type === "file") : [])
      expect(activeFiles).toEqual(completed ? [] : [{ type: "file", mediaType: "image/png", filename: "chart.png", object }])
      expect(result.log.slice(0, initial.length)).toEqual(initial)
      expect(result.log.find(event => event.type === "CompactionCompleted")).toMatchObject({ fileTokens: TEST_CONTEXT.fileTokens })
    })
  }

  test("a missing storage service leaves the cut intact for recovery", async () => {
    const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(
      objectStorageFromKeyValueStore().pipe(Layer.provide(KeyValueStore.layerMemory))
    )))
    const object = await Effect.runPromise(storage.put(new Uint8Array([1, 2, 3])))
    const initial: Event[] = [
      { type: "MessageReceived", id: "m0", content: [{ type: "file", mediaType: "image/png", object }], at: 0 },
      ...openTurn(16).slice(1)
    ]
    const failed = await run(initial)
    expect(failed.exit._tag).toBe("Failure")
    expect(failed.nativePrompt).toBeUndefined()
    expect(checkpointOf(failed.log)).toEqual(checkpointOf(initial))
    expect(renderMessages(failed.log)).toEqual(renderMessages(initial))
    const recovered = await run(failed.log, TEST_POLICY, undefined, storage)
    expect(recovered.exit._tag).toBe("Success")
    expect(recovered.log.filter(event => event.type === "CompactionCompleted")).toHaveLength(1)
  })

  test.each([
    { kind: "fail", error: "provider unavailable" },
    { kind: "calls", calls: [{ callId: "unexpected", name: "read", arguments: {} }] },
    { kind: "complete", output: "   " }
  ] satisfies Action[])("an unusable summary preserves history until successful recovery: %j", async (outcome) => {
    const initial = openTurn(16)
    const failed = await run(initial, TEST_POLICY, outcome)
    expect(failed.exit._tag).toBe("Failure")
    expect(failed.log.filter((event) => event.type === "CompactionCompleted")).toEqual([])
    expect(checkpointOf(failed.log)).toEqual(checkpointOf(initial))
    expect(renderMessages(failed.log)).toEqual(renderMessages(initial))
    expect(reactor(failed.log).map((transition) => transition.key)).toEqual(reactor(initial).map((transition) => transition.key))
    const recovered = await run(failed.log)
    expect(recovered.exit._tag).toBe("Success")
    expect(recovered.log.filter((event) => event.type === "CompactionCompleted")).toHaveLength(1)
    expect(keepFromIndex(recovered.log, checkpointOf(recovered.log).keepFrom)).toBeGreaterThan(0)
    expect(recovered.briefed()).toContain("run 1")
    expect(recovered.log.slice(0, initial.length)).toEqual(initial)
  })

  test("a successful summary commits an advancing checkpoint within the open turn", async () => {
    const { log, briefed } = await run(openTurn(16))
    const checkpoint = checkpointOf(log)
    expect(log.find((event) => event.type === "CompactionCompleted")).toMatchObject({
      keepTokens: Math.floor(estimateTokens(openTurn(16), TEST_CONTEXT) * TEST_POLICY.keepRatio)
    })
    expect(checkpoint.summary).toBe("covenants 1 through 13 extracted")
    expect(keepFromIndex(log, checkpoint.keepFrom)).toBeGreaterThan(0)
    // The retained tail allows slack for a complete tool round.
    const roundTokens = estimateTokens(round(1))
    expect(estimateTokens(suffixOf(log))).toBeLessThanOrEqual(Math.floor(estimateTokens(openTurn(16), TEST_CONTEXT) * TEST_POLICY.keepRatio) + 2 * roundTokens)
    expect(briefed()).toContain("extract the covenants")
    expect(briefed()).toContain("run 1")
    const suffix = suffixOf(log)
    expect(suffix[0]!.type).toBe("ToolCalled")
    const callId = String((suffix[0] as { callId?: unknown }).callId)
    expect(checkpointOf(log).keepFrom).toBe(`c:${JSON.stringify([suffix[0]!.turn ?? null, callId])}`)
    expect(suffix.some((e) => e.type === "ToolReturned" && String((e as { callId?: unknown }).callId) === callId)).toBe(
      true
    )
  })

  test("new resolved rounds allow a later checkpoint", async () => {
    const first = await run(openTurn(16))
    const grown: Event[] = [...first.log]
    for (let i = 17; i <= 32; i++) grown.push(...round(i, "m0", grown.length + 1))
    const second = await run(grown)
    const checkpoint = checkpointOf(second.log)
    expect(keepFromIndex(second.log, checkpoint.keepFrom)).toBeGreaterThan(
      keepFromIndex(first.log, checkpointOf(first.log).keepFrom)
    )
  })
})

describe("a projected repair is invisible to compaction as well as to the render", () => {
  const REPAIR = { kind: "repair", name: "repair", attempts: 2, projectHistory: true }
  const rejected = (turn: string, at: number, implementation: unknown = REPAIR): Event => ({
    type: "OutputRejected",
    contract: "scout",
    attempt: `${turn}/infer/0`,
    text: "x".repeat(4_000),
    errors: ["/a: expected string"],
    mode: implementation,
    turn,
    at
  })

  test("the summary brief never carries a corrected reply, and the log still does", async () => {
    const briefs: string[] = []
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: { code: "x".repeat(80_000) }, turn: "m1", at: 1 },
      { type: "ToolReturned", transitionRef: { seq: 2, component: "tools", tag: "answer" }, callId: "c1", result: "ok", turn: "m1", at: 2 },
      rejected("m1", 3),
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 4 },
      { type: "MessageReceived", id: "m2", text: "next", at: 5 },
      { type: "ToolCalled", callId: "c2", name: "execute", arguments: { code: "return 2" }, turn: "m2", at: 6 },
      { type: "ToolReturned", transitionRef: { seq: 7, component: "tools", tag: "answer" }, callId: "c2", result: "ok", turn: "m2", at: 7 }
    ]
    const events = await Effect.runPromise(
      Effect.all(reactor(log).map((transition) => {
        if (transition.kind !== "effect") throw new Error("compaction must be an effect")
        return transition.act(transition.input as never, new AbortController().signal)
      })).pipe(
        Effect.provide(
          Layer.mergeAll(
            summaryLayer((prompt) => {
                briefs.push(prompt)
                return Effect.succeed({ kind: "complete" as const, output: "summarized" })
            }),
            Layer.succeed(Self, { actor: "test", instance: "main", thread: "compaction" })
          )
        )
      ) as unknown as Effect.Effect<ReadonlyArray<ReadonlyArray<Event>>>
    )
    expect(events.flat().some((e) => e.type === "CompactionCompleted")).toBe(true)
    expect(briefs).toHaveLength(1)
    expect(briefs[0]).not.toContain("agent (refused")
    expect(briefs[0]).not.toContain("xxxx")
    // The rejection is still a fact of the log; only every reader of the projection dropped it.
    expect(log.some((e) => e.type === "OutputRejected")).toBe(true)
  })
})

for (const explicit of [false, true]) {
  test(`summary model is resolved before execution (override: ${explicit})`, async () => {
    const fallback = { provider: "test", model_id: "default-summary" }
    const override = { provider: "test", model_id: "explicit-summary" }
    const selected = explicit ? override : fallback
    const lookedUp: Array<ModelRef | undefined> = []
    const lock = testModelLock(model => {
      lookedUp.push(model)
      return { model: model ?? fallback, contextWindowTokens: 128_000 }
    })
    const child = compact(messages(), { ...TEST_POLICY, ...(explicit ? { model: override } : {}) })
    const output = replayProjection(machineOf(child), openTurn(16), Context.make(ModelLock, lock))
    const proposal = output.transitions.find(transition => transition.kind === "effect")
    expect(proposal?.input).toMatchObject({ model: selected })
    expect(lookedUp).toContainEqual(explicit ? override : undefined)
    if (proposal?.kind !== "effect") throw new Error("Expected a summary proposal")
    const before = lookedUp.length
    const events = await Effect.runPromise(proposal.act(proposal.input, new AbortController().signal).pipe(
      Effect.provide(summaryLayer((_prompt, model) => {
        expect(model).toEqual(selected)
        return Effect.succeed({ kind: "complete", output: "A compact summary." })
      })),
      Effect.provideService(ModelLock, lock),
      Effect.provideService(EventLog, withWatermark({ read: Effect.succeed(openTurn(16)), append: () => Effect.die("The proposal returns completion events") })),
      Effect.provideService(Self, { actor: "test", instance: "main", thread: "compaction" })
    ))
    expect(lookedUp).toHaveLength(before)
    expect(events).toContainEqual(expect.objectContaining({ type: "CompactionCompleted", model: selected }))
  })
}


const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const
const assembled = <R>(child: AgentComponent<R>) => actor({ name: "test-agent", methods: agentMethods, components: [child] })

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

const checkModelCapacity = async ({ capacity, previousCapacity, summaryCapacity, historySize, fireRatio, keepRatio, mode, compact: shouldCompact }: {
  readonly capacity: number
  readonly previousCapacity: number
  readonly summaryCapacity: number
  readonly historySize: number
  readonly fireRatio: number
  readonly keepRatio: number
  readonly mode: string
  readonly compact: boolean
}) => {
  const calls: string[] = []
  let prefix: ReadonlyArray<Event> = []
  const thresholds = { contextWindowTokens: capacity, fireTokens: Math.floor(capacity * fireRatio) }
  const model = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: () => Effect.die("stream only"),
    streamText: () => Stream.unwrap(Effect.gen(function* () {
      const invocation = yield* BindingInvocation
      const selected = yield* CurrentModel
      calls.push(selected!.model_id)
      if (invocation !== undefined && selected?.model_id === "small") {
        expect(invocation.request.trajectory.some(event => event.type === "CompactionCompleted")).toBe(shouldCompact)
        expect(invocation.request.context).toMatchObject(thresholds)
      }
      return Stream.fromIterable([
        Response.makePart("text-start", { id: "text" }),
        Response.makePart("text-delta", { id: "text", delta: invocation === undefined ? "Earlier work." : "Done." }),
        Response.makePart("text-end", { id: "text" }),
        Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) })
      ])
    }))
  }))
  const resolve = (reference = { provider: "test", model_id: "host-default" }) => ({
    model: reference, contextWindowTokens: reference.model_id === "small" ? capacity : reference.model_id === "large" ? previousCapacity : summaryCapacity
  })
  const selection = Layer.succeed(ModelLock, testModelLock(resolve))
  const agent = assembled(infer([compact(messages(), { triggerRatio: fireRatio, retainRatio: keepRatio, ...(mode === "explicit" ? { model: { provider: "test", model_id: "summary" } } : {}) }), nativeOutput], TEST_MODEL))
  const events = await run(Effect.gen(function* () {
    yield* receive(agent, { id: "large-turn", text: "x".repeat(historySize), model: { provider: "test", model_id: "large" } })
    prefix = yield* readLog
    yield* receive(agent, { id: "small-turn", text: "continue", model: { provider: "test", model_id: "small" } })
    return yield* readLog
  }), Layer.mergeAll(memoryLog(), model, selection, noRouter, KeyValueStore.layerMemory))
  const summarizer = mode === "explicit" ? "summary" : "host-default"
  expect(calls).toEqual(shouldCompact ? ["large", summarizer, "small"] : ["large", "small"])
  const checkpoints = events.filter(event => event.type === "CompactionCompleted")
  expect(checkpoints).toHaveLength(shouldCompact ? 1 : 0)
  if (shouldCompact) expect(checkpoints[0]).toMatchObject({ model: { provider: "test", model_id: summarizer } })
  expect(events.slice(0, prefix.length)).toEqual([...prefix])
  expect(events.filter(event => event.type === "MessageReceived").map(event => event.model)).toEqual([
    { provider: "test", model_id: "large" }, { provider: "test", model_id: "small" }
  ])
  expect(events.filter(event => event.type === "ModelCalled").map(event => event.model)).toEqual([
    { provider: "test", model_id: "large" }, { provider: "test", model_id: "small" }
  ])
  expect(events.filter(event => event.type === "TurnCompleted")).toHaveLength(2)
}

test("infer selects compaction against model capacity independently of the summarizer", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    capacity: fc.integer({ min: 300, max: 1200 }),
    previousMultiplier: fc.integer({ min: 3, max: 20 }),
    summaryCapacity: fc.integer({ min: 64, max: 100_000 }),
    firePercent: fc.integer({ min: 60, max: 90 }),
    keepPercent: fc.integer({ min: 20, max: 50 }),
    mode: fc.constantFrom("explicit", "default"),
    compact: fc.boolean()
  }), async ({ capacity, previousMultiplier, summaryCapacity, firePercent, keepPercent, mode, compact }) => {
    await checkModelCapacity({
      capacity, previousCapacity: capacity * previousMultiplier, summaryCapacity,
      historySize: compact ? capacity * 4 + 400 : 16,
      fireRatio: firePercent / 100, keepRatio: keepPercent / 100, mode, compact
    })
  }), {
    numRuns: 50,
    examples: [
      [{ capacity: 100, previousMultiplier: 10_000, summaryCapacity: 1_000_000, firePercent: 80, keepPercent: 50, mode: "explicit", compact: true }],
      [{ capacity: 100, previousMultiplier: 10_000, summaryCapacity: 1_000_000, firePercent: 80, keepPercent: 50, mode: "default", compact: true }],
      [{ capacity: 300, previousMultiplier: 3, summaryCapacity: 64, firePercent: 60, keepPercent: 20, mode: "explicit", compact: false }],
      [{ capacity: 300, previousMultiplier: 3, summaryCapacity: 64, firePercent: 60, keepPercent: 20, mode: "default", compact: false }]
    ]
  })
})

test.each([undefined, 0, -1, NaN, Infinity])("infer rejects invalid model capacity (%s) before selecting compaction", async window => {
  let calls = 0
  const mind = testInferenceLayer({ resolve: model => ({ model: model!, ...(window === undefined ? {} : { contextWindowTokens: window }) }), react: () => {
    calls++
    return Effect.succeed({ kind: "complete", output: "unexpected" })
  } })
  const events = await run(Effect.gen(function* () {
    yield* receive(assembled(infer([compact(messages()), nativeOutput], TEST_MODEL)), { id: "missing", text: "go" })
    return yield* readLog
  }), Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory))
  expect(calls).toBe(0)
  expect(events.find(event => event.type === "TurnFailed")).toMatchObject({ cause: "model_selection" })
})
