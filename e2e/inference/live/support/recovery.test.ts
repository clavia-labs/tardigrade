import { expect, test } from "bun:test"
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import { runProvider, runBinding } from "./translation"
import { runTarget } from "./recovery"
import { resolveTarget, type ResolvedLiveTarget } from "./config"
import { targetById } from "../targets"
import { cleanup, registerCleanup } from "../../cleanup"

const target: ResolvedLiveTarget = { id: "fixture", protocol: "openai-chat-completions", credential: "UNUSED", modelEnv: "UNUSED", contextWindowEnv: "UNUSED", endpoint: "https://fixture.invalid", model: "real-configured-model", contextWindowTokens: 10000, apiKey: "fixture", behaviors: ["completion", "tool-loop", "recovery"] }

test("HTTP live contract sends the configured model through both inferences", async () => {
  const models: string[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: string }> }
    models.push(body.model)
    const result = body.messages.find((message) => message.role === "tool")
    const nonce = result?.content.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]
    const delta = result === undefined ? { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read_nonce", arguments: "{}" } }] } : { content: nonce }
    return new Response(`data: ${JSON.stringify({ id: "r", model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: result === undefined ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const configured = { ...target, endpoint: server.url.toString() }
    await runProvider(configured)
    await runBinding(configured)
    await runTarget(configured)
  } finally { await server.stop(true) }
  expect(models).toEqual(Array(6).fill(target.model))
})

test("Converse live contract runs native events through durable reasoning replay", async () => {
  const models: Array<string | undefined> = []
  await runTarget({ ...target, protocol: "bedrock-converse", region: "us-east-1", behaviors: [...target.behaviors, "reasoning"] }, { bedrockSend: async (input) => {
    models.push(input.modelId)
    const result = input.messages?.flatMap((message) => message.content ?? []).find((part) => part.toolResult)?.toolResult
    const nonce = (JSON.stringify(result) ?? "").match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]
    const events: ConverseStreamOutput[] = result === undefined ? [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Check" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "signed" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call", name: "read_nonce" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: "{}" } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } }
    ] : [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: nonce ?? "missing nonce" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } }
    ]
    return { $metadata: {}, stream: (async function* () { yield* events; yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } } } })() }
  } })
  expect(models).toEqual([target.model, target.model])
})

test("cleanup releases remaining acquisitions after a closer fails", async () => {
  const tasks: Array<() => unknown> = []
  const closed: string[] = []
  const close = (name: string) => { closed.push(name) }
  registerCleanup(tasks, "storage", close)
  const releaseOldHost = registerCleanup(tasks, "old host", close)
  await releaseOldHost()
  registerCleanup(tasks, "new host", close)
  const error = new Error("server close failed")
  registerCleanup(tasks, "server", (name) => { close(name); throw error })

  const failure = await cleanup(tasks).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([error])
  expect(closed).toEqual(["old host", "server", "new host", "storage"])
})

test("Bedrock derives its native endpoint from explicit region and rejects missing configuration", () => {
  const target = { ...targetById("bedrock-converse")!, credential: "TEST_LIVE_KEY", regionEnv: "TEST_LIVE_REGION", modelEnv: "TEST_LIVE_MODEL", contextWindowEnv: "TEST_LIVE_CONTEXT", endpointEnv: "TEST_LIVE_ENDPOINT" }
  const names = [target.credential, target.regionEnv, target.modelEnv, target.contextWindowEnv, target.endpointEnv]
  const previous = names.map((name) => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    expect(() => resolveTarget(target)).toThrow("TEST_LIVE_REGION")
    process.env.TEST_LIVE_REGION = "eu-west-1"
    process.env.TEST_LIVE_KEY = "fixture"
    process.env.TEST_LIVE_MODEL = "chosen-model"
    process.env.TEST_LIVE_CONTEXT = "10000"
    expect(resolveTarget(target)).toMatchObject({ endpoint: "https://bedrock-runtime.eu-west-1.amazonaws.com", model: "chosen-model", region: "eu-west-1" })
    delete process.env.TEST_LIVE_KEY
    expect(() => resolveTarget(target)).toThrow("TEST_LIVE_KEY")
  } finally {
    names.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value })
  }
})
