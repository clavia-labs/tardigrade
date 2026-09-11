import assert from "node:assert/strict"
import { test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { actor } from "tardie/core"
import { agentMethods, infer, tool, outputValidateOnce } from "tardie/agent"
import { createBunHost, serve } from "tardie/bun"
import { modelLayer } from "../../packages/model/src/host"
import { cleanup, registerCleanup } from "./cleanup"

const enabled = process.env.TARDIE_LIVE_REASONING === "1"
export const DEFAULT_LIVE_TIMEOUT_MS = 240_000
export const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 8192
export const DEFAULT_LIVE_THINKING_TOKENS = 2048

const positive = (name: string, fallback?: number) => {
  const value = Number(process.env[name] ?? fallback)
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  return value
}
const required = (name: string) => {
  const value = process.env[name]
  assert.ok(value, `Set ${name} for the live reasoning test`)
  return value
}

type StoredEvent = { type: string; continuation?: unknown; text?: string; output?: string; error?: { code?: string; message?: string } }
const opaqueValues = (value: unknown): string[] => {
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) =>
    (key === "encrypted_content" || key === "signature") && typeof item === "string" && item.length > 0
      ? [item] : opaqueValues(item))
}

const timeout = enabled ? positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS) : DEFAULT_LIVE_TIMEOUT_MS

test.skipIf(!enabled)("live reasoning survives durable tool execution and provider replay", async () => {
  const provider = required("TARDIE_LIVE_PROVIDER")
  assert.ok(provider === "openai" || provider === "anthropic", "TARDIE_LIVE_PROVIDER must be openai or anthropic")
  const model = required("TARDIE_LIVE_MODEL")
  const apiKey = required(provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY")
  const contextWindowTokens = positive("TARDIE_LIVE_CONTEXT_TOKENS")
  const maxOutputTokens = positive("TARDIE_LIVE_MAX_OUTPUT_TOKENS", DEFAULT_LIVE_MAX_OUTPUT_TOKENS)
  const thinkingTokens = positive("TARDIE_LIVE_THINKING_TOKENS", DEFAULT_LIVE_THINKING_TOKENS)
  assert.ok(maxOutputTokens > thinkingTokens, "Output allowance must exceed the thinking budget")
  const upstream = process.env.TARDIE_LIVE_BASE_URL ?? (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1")
  const storage = await mkdtemp(join(tmpdir(), "reasoning-live-"))
  const nonce = crypto.randomUUID()
  let serverUrl: URL
  let requests = 0
  let replayChecked = false
  const responseEvidence: Array<Promise<{ opaqueParts: number; reasoningTokens: number }>> = []
  let toolRan = false
  let toolExecutions = 0
  const events = async (): Promise<StoredEvent[]> => {
    const response = await fetch(new URL("/v1/actors/main/threads/live/events", serverUrl))
    assert.equal(response.status, 200)
    const rows = await response.json() as Array<{ event: StoredEvent }>
    return rows.map((row) => row.event)
  }
  const cleanups: Array<() => unknown> = [() => rm(storage, { recursive: true, force: true })]
  try {
    const proxy = Bun.serve({ port: 0, fetch: async (request) => {
      const body = await request.text()
      requests++
      if (toolRan) {
        const opaque = opaqueValues(JSON.parse(body))
        const evidence = await Promise.all(responseEvidence)
        assert.ok(opaque.length > 0, `Follow-up request must contain native reasoning evidence; provider evidence: ${JSON.stringify(evidence)}`)
        const saved = (await events()).filter((event) => event.type === "ModelReturned" && event.continuation !== undefined)
        assert.ok(opaque.every((value) => saved.some((event) => JSON.stringify(event.continuation).includes(JSON.stringify(value)))), "Replayed reasoning must match a persisted continuation")
        assert.ok(body.includes(nonce), "Follow-up request must include the tool result")
        replayChecked = true
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const response = await fetch(`${upstream}${new URL(request.url).pathname}`, { method: "POST", headers, body, signal: request.signal })
      responseEvidence.push(response.clone().text().then((text) => {
        const parts = text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").flatMap((line) => {
          try { return [JSON.parse(line.slice(6))] } catch { return [] }
        })
        return { opaqueParts: opaqueValues(parts).length, reasoningTokens: parts.reduce((sum, part) => sum + (part.response?.usage?.output_tokens_details?.reasoning_tokens ?? 0), 0) }
      }).catch(() => ({ opaqueParts: 0, reasoningTokens: 0 })))
      return response
    } })
    registerCleanup(cleanups, proxy, (proxy) => proxy.stop(true))
    const selection = { default: { provider, model_id: model }, allow: "*" as const }
    const definition = actor({ name: "reasoning-live", methods: agentMethods, components: [infer([outputValidateOnce, tool({
      spec: { name: "read_nonce", description: "Read the secret nonce needed for the answer", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      run: () => Effect.promise(async () => {
        const saved = await events()
        assert.ok(saved.some((event) => event.type === "ModelReturned" && event.continuation !== undefined), "Continuation must be durable before the tool executes")
        toolRan = true
        toolExecutions++
        return { nonce }
      })
    })], { models: selection })] })
    const open = () => createBunHost({ actor: definition, storage, layersFor: () => modelLayer({
      model: { ...selection, providers: { [provider]: { baseUrl: proxy.url.toString().replace(/\/$/, ""), protocol: provider === "openai" ? "openai-responses" : "anthropic-messages", env: ["LIVE_KEY"] } } },
      modelCredentials: { LIVE_KEY: apiKey }
    }, { snapshot: { source: "models.dev", revision: "live", refreshedAt: Date.now(), status: "fresh", providers: [{ id: provider, name: provider, env: [], models: [{ id: model, metadata: { contextWindowTokens, maxOutputTokens } }] }] } }, {
      configure: () => ({ maxOutputTokens, throttleRetryDelaysMs: [], stream: { totalMs: timeout },
        ...(provider === "openai" ? { openai: { store: false, reasoning: { effort: "high" as const } } }
          : { anthropic: { thinking: { type: "enabled" as const, budget_tokens: thinkingTokens } } }) })
    }) })
    let host = await open()
    let closeHost = registerCleanup(cleanups, host, (host) => host.close())
    let server = await serve(host, { port: 0 })
    let closeServer = registerCleanup(cleanups, server, (server) => server.close())
    serverUrl = server.url
    const send = (path: string, method: string, body: unknown) => fetch(new URL(path, serverUrl), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal((await send("/v1/actors/main", "PUT", {})).status, 200)
    assert.equal((await send("/v1/actors/main/threads", "POST", { name: "live" })).status, 200)
    const path = "/v1/actors/main/threads/live/methods/message/calls/m1"
    assert.equal((await send(path, "PUT", { text: "Use read_nonce exactly once. Think about why you cannot know its secret value before calling it. After receiving the result, reply with the nonce exactly. Do not call any more tools." })).status, 202)
    const deadline = Date.now() + timeout
    let status: unknown = "pending"
    while (status === "pending" && Date.now() < deadline) {
      const response = await fetch(new URL(path, serverUrl))
      assert.equal(response.status, 200)
      status = (await response.json() as { status: string }).status
      if (status === "pending") await Bun.sleep(100)
    }
    const failures = (await events()).filter((event) => event.type === "TurnFailed").map((event) => ({ code: event.error?.code, message: event.error?.message?.replaceAll(apiKey, "[redacted]") }))
    assert.equal(status, "completed", `Live turn must complete; failures: ${JSON.stringify(failures)}; provider evidence: ${JSON.stringify(await Promise.all(responseEvidence))}`)
    assert.equal(toolExecutions, 1, "The nonce tool must execute exactly once")
    assert.ok(toolRan && replayChecked, "Live turn must execute a tool and replay persisted reasoning")
    const saved = await events()
    assert.ok(saved.some((event) => event.type === "TurnCompleted" && event.output?.includes(nonce)), "Final answer must contain the tool's nonce")
    const requestCount = requests
    await closeServer()
    await closeHost()
    host = await open()
    closeHost = registerCleanup(cleanups, host, (host) => host.close())
    server = await serve(host, { port: 0 })
    closeServer = registerCleanup(cleanups, server, (server) => server.close())
    serverUrl = server.url
    assert.ok(JSON.stringify(await events()) === JSON.stringify(saved), "Events must survive host restart")
    assert.equal((await (await fetch(new URL(path, serverUrl))).json() as { status: string }).status, "completed")
    assert.equal(requests, requestCount, "Completed turn must not call the provider again after restart")
  } finally {
    await cleanup(cleanups)
  }
}, timeout + 10_000)
