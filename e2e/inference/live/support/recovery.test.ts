import { expect, test } from "bun:test"
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import { runProvider, runBinding } from "./translation"
import { runTarget, runLifecycle } from "./recovery"
import { resolveTarget, type ResolvedLiveTarget } from "./config"
import { targetById } from "../targets"
import { cleanup, registerCleanup } from "../../cleanup"

const target: ResolvedLiveTarget = { id: "fixture", protocol: "openai-chat-completions", credential: "UNUSED", modelEnv: "UNUSED", contextWindowEnv: "UNUSED", endpoint: "https://fixture.invalid", model: "real-configured-model", contextWindowTokens: 10000, apiKey: "fixture", behaviors: ["completion", "tool-loop", "recovery"] }

test("HTTP live contracts preserve history through tool evolution, restart, and model handoff", async () => {
  const models: string[] = []
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; parameters: { required?: string[] } } }> }
    models.push(body.model)
    const userIndex = body.messages.findLastIndex((message) => message.role === "user")
    const result = body.messages.slice(userIndex + 1).find((message) => message.role === "tool")
    const nonce = JSON.stringify(body.messages).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)?.at(-1)
    const selected = body.tools?.[0]?.function
    const calls = result === undefined && selected !== undefined
    const params = selected?.parameters.required?.[0]
    const delta = calls ? { tool_calls: [{ index: 0, id: `call-${body.messages.length}`, type: "function", function: { name: selected.name, arguments: JSON.stringify(params === undefined ? {} : { [params]: nonce }) } }] } : { content: nonce }
    return new Response(`data: ${JSON.stringify({ id: `r-${models.length}`, model: body.model, created: 1, choices: [{ index: 0, delta, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const configured = { ...target, endpoint: server.url.toString() }
    await runProvider(configured)
    await runBinding(configured)
    await runTarget(configured)
    expect(await runLifecycle([configured, { ...configured, id: "other", model: "other-model" }])).toEqual({ turns: 4, requests: 7 })
  } finally { await server.stop(true) }
  expect(models).toEqual([...Array(10).fill(target.model), "other-model", "other-model", target.model])
}, 15_000)

test("Converse lifecycle preserves tool history and durably rejects disabled tools", async () => {
  const models: Array<string | undefined> = []
  const configured: ResolvedLiveTarget = { ...target, protocol: "bedrock-converse", region: "us-east-1", behaviors: [...target.behaviors, "reasoning"] }
  const outcome = await runLifecycle([configured, { ...configured, id: "other", model: "other-model" }], { bedrockSend: async (input) => {
    models.push(input.modelId)
    const result = input.messages?.at(-1)?.content?.at(-1)?.toolResult
    const nonce = JSON.stringify(input.messages).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g)?.at(-1)
    const selected = input.toolConfig?.tools?.[0]?.toolSpec
    const param = JSON.stringify(selected?.inputSchema).includes("priorNonce") ? "priorNonce" : selected?.name === "check_nonce" ? "nonce" : undefined
    const events: ConverseStreamOutput[] = result === undefined ? [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Check" } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: `signed-${input.modelId}-${models.length}` } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: `call-${models.length}`, name: selected?.name ?? "missing" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: JSON.stringify(param === undefined ? {} : { [param]: nonce }) } } } },
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
  expect(outcome).toEqual({ turns: 4, requests: 6 })
  expect(models).toEqual([target.model, target.model, target.model, target.model, "other-model", "other-model"])
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
