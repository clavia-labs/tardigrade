import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import type { ConverseStreamCommandInput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import { collectResponse } from "./response"
import { providerLayer } from "./layer"
import { inferenceLayer } from "../binding/index"


const events = (truncated = false): ConverseStreamOutput[] => [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Check" } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed" } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } } },
  { contentBlockStop: { contentBlockIndex: 1 } },
  ...["a", "b", "c"].flatMap((id, index): ConverseStreamOutput[] => [
    { contentBlockStart: { contentBlockIndex: index + 2, start: { toolUse: { toolUseId: id, name: "read" } } } },
    { contentBlockDelta: { contentBlockIndex: index + 2, delta: { toolUse: { input: truncated ? '{"path":' : JSON.stringify({ path: id === "b" ? 123 : id }) } } } },
    { contentBlockStop: { contentBlockIndex: index + 2 } }
  ]),
  { messageStop: { stopReason: truncated ? "max_tokens" : "tool_use" } },
  { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } }
]
const toolkit = Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }), failureMode: "return" }))

for (const interleaved of [false, true]) {
test(`Bedrock preserves signed and redacted reasoning beside rejected calls (interleaved: ${interleaved})`, async () => {
  const inputs: ConverseStreamCommandInput[] = []
  const signals: AbortSignal[] = []
  const layer = providerLayer({ provider: "bedrock", model: { model: "claude", config: { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } } } }, client: { send: async (input, signal) => {
    inputs.push(input); signals.push(signal)
    const all = events()
    const tools = all.slice(6, -2)
    return { $metadata: {}, stream: (async function* () { yield* interleaved ? [...all.slice(0, 6), ...tools.filter((event) => event.contentBlockStop === undefined), ...tools.filter((event) => event.contentBlockStop !== undefined).reverse(), ...all.slice(-2)] : all })() }
  } } })
  const run = (prompt: Prompt.RawInput) => Effect.runPromise(collectResponse(prompt, toolkit, undefined, { type: "json", objectName: "answer", schema: Schema.Struct({ answer: Schema.String }) }).pipe(Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer)))))
  const first = await run("Read")
  expect(first.parts.filter((part) => part.type === "tool-call").map((part) => part.id)).toEqual(["a", "c"])
  expect(first.parts.find((part) => part.type === "error")?.error).toMatchObject({ _tag: "ToolCallValidationError", id: "b" })
  expect(first.parts.find((part) => part.type === "finish")).toMatchObject({ usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } })
  const restored = Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(JSON.stringify(first.continuation)))
  await run(Prompt.concat(restored, Prompt.make([{ role: "tool", content: ["a", "b", "c"].map((id) => ({ type: "tool-result" as const, id, name: "read", result: "contents", isFailure: id === "b" })) }])))
  expect(inputs[1]?.messages?.find((message) => message.role === "assistant")?.content).toMatchObject([
    { reasoningContent: { reasoningText: { text: "Check", signature: "signed" } } },
    { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
    ...["a", "b", "c"].map((id) => ({ toolUse: { toolUseId: id } }))
  ])
  expect(inputs[1]?.messages?.at(-1)?.content?.[1]).toMatchObject({ toolResult: { toolUseId: "b", status: "error" } })
  expect(inputs[0]).toMatchObject({ additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } }, outputConfig: { textFormat: { type: "json_schema" } } })
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})
}

test("Bedrock truncation fails once and retains usage", async () => {
  const inputs: ConverseStreamCommandInput[] = []
  const layer = inferenceLayer({ provider: "bedrock", endpoint: "https://bedrock.invalid", model: { model: "claude" }, maxOutputTokens: 100, retry: { backoffMs: [0] }, client: { send: async (input) => {
    inputs.push(input)
    return { $metadata: {}, stream: (async function* () { yield* events(inputs.length === 1) })() }
  } } })
  const action = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }] })
  }).pipe(Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer)))))
  expect(inputs.map((input) => input.inferenceConfig?.maxTokens)).toEqual([100])
  expect(action).toMatchObject({ kind: "fail", error: { reason: { _tag: "UnknownError" } }, failure: { cause: "output_limit", attempts: 1 }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } })
  expect(action).not.toHaveProperty("calls")
  expect(action).not.toHaveProperty("continuation")
  expect(action.finish?.metadata).toBeDefined()
})

test("Bedrock incomplete streams fail at the Tardie binding", async () => {
  const layer = providerLayer({ provider: "bedrock", model: { model: "claude" }, client: { send: async () => ({ $metadata: {}, stream: (async function* () { yield* events().slice(0, -1) })() }) } })
  const outcome = await Effect.runPromise(collectResponse("Read", toolkit).pipe(Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.result))
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag === "Failure") expect(outcome.failure).toMatchObject({ _tag: "StreamIncomplete" })
})

test("Bedrock normalizes cache buckets before estimating cost", async () => {
  const nativeUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 }
  const layer = inferenceLayer({ provider: "bedrock", endpoint: "https://fixture.invalid", model: { model: "claude" }, pricing: { promptUsdPerToken: 1, completionUsdPerToken: 2, cachedPromptUsdPerToken: 0.1, cacheWritePromptUsdPerToken: 1.25 }, client: { send: async () => ({ $metadata: {}, stream: (async function* () {
    yield { messageStop: { stopReason: "end_turn" as const } }
    yield { metadata: { usage: nativeUsage, metrics: { latencyMs: 1 } } }
  })() }) } })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* inferenceClient
    return yield* infer.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [] })
  }).pipe(Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer)))))
  expect(result.usage).toMatchObject({ inputTokens: { total: 15, cacheRead: 3, cacheWrite: 2 }, outputTokens: { total: 5 } })
  expect(JSON.stringify(result.finish?.metadata)).toContain(JSON.stringify(nativeUsage))
})
