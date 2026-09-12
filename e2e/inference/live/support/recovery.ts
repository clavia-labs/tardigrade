import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockSend } from "../../../../packages/model/src/providers/bedrock"
import { inferenceLayer } from "../../../../packages/model/src/binding/index"
import { modelLayerWith } from "../../../../packages/model/src/selection"
import { actor } from "tardie/core"
import { agentMethods, infer, outputValidateOnce, tool } from "tardie/agent"
import { createBunHost, serve } from "tardie/bun"
import { modelLayer } from "../../../../packages/model/src/host"
import { cleanup, registerCleanup } from "../../cleanup"
import { DEFAULT_LIVE_MAX_OUTPUT_TOKENS, DEFAULT_LIVE_THINKING_TOKENS, DEFAULT_LIVE_TIMEOUT_MS, positive, type ResolvedLiveTarget } from "./config"
import { drivers } from "../targets"


type StoredEvent = { readonly type: string; readonly continuation?: unknown; readonly output?: string; readonly error?: { readonly code?: string; readonly message?: string } }

const definition = (target: ResolvedLiveTarget, events: () => Promise<ReadonlyArray<StoredEvent>>, nonce: string, onTool: () => void) => actor({ name: "live-inference", methods: agentMethods, components: [infer([outputValidateOnce, tool({
  spec: { name: "read_nonce", description: "Read the secret nonce needed for the answer", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  run: () => Effect.promise(async () => {
    assert.ok((await events()).some((event) => event.type === "ModelReturned" && event.continuation !== undefined), "Continuation must be durable before the tool executes")
    onTool()
    return { nonce }
  })
})], { models: { default: { provider: "live", model_id: target.model }, allow: "*" } })] })

export const runTarget = async (target: ResolvedLiveTarget, overrides: { readonly bedrockSend?: BedrockSend } = {}) => {
  const timeout = positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS)
  const driver = drivers[target.protocol]
  const storage = await mkdtemp(join(tmpdir(), "inference-live-"))
  const nonce = crypto.randomUUID()
  const cleanups: Array<() => unknown> = [() => rm(storage, { recursive: true, force: true })]
  let serverUrl: URL
  let requests = 0
  let toolExecutions = 0
  let followUpChecked = false
  const responseEvidence: Array<Promise<{ readonly native: ReturnType<typeof driver.responseEvidence>; readonly opaque: ReadonlyArray<string> }>> = []
  const events = async (): Promise<ReadonlyArray<StoredEvent>> => {
    const response = await fetch(new URL("/v1/actors/main/threads/live/events", serverUrl))
    assert.equal(response.status, 200)
    return (await response.json() as Array<{ readonly event: StoredEvent }>).map((row) => row.event)
  }
  const inspectRequest = async (body: string) => {
    requests++
      if (toolExecutions > 0) {
        const evidence = driver.followUpEvidence(body, nonce)
        if (target.behaviors.includes("reasoning")) assert.ok(evidence.opaqueParts > 0, "Follow-up request must include native reasoning evidence")
        assert.ok(evidence.hasToolResult, "Follow-up request must include the tool result")
        const saved = JSON.stringify((await events()).filter((event) => event.type === "ModelReturned").map((event) => event.continuation))
        const expected = (await Promise.all(responseEvidence)).flatMap((entry) => entry.opaque)
        if (target.behaviors.includes("reasoning")) assert.ok(expected.length > 0 && expected.every((value) => saved.includes(JSON.stringify(value)) && body.includes(JSON.stringify(value))), `Follow-up reasoning must match persisted native evidence (final items: ${expected.length}, stored: ${expected.filter((value) => saved.includes(JSON.stringify(value))).length}, replayed: ${expected.filter((value) => body.includes(JSON.stringify(value))).length})`)
        followUpChecked = true
      }
  }
  try {
    const proxy = target.protocol === "bedrock-converse" ? undefined : Bun.serve({ port: 0, fetch: async (request) => {
      const body = await request.text()
      await inspectRequest(body)
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      const response = await fetch(`${target.endpoint.replace(/\/$/, "")}${new URL(request.url).pathname}`, { method: "POST", headers, body, signal: request.signal })
      responseEvidence.push((async () => {
        const reader = response.clone().body?.getReader()
        const decoder = new TextDecoder()
        let text = ""
        try {
          if (reader !== undefined) while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            text += decoder.decode(chunk.value, { stream: true })
          }
        } catch {
          // reader retains evidence received before the provider closes its stream.
        } finally { reader?.releaseLock() }
        text += decoder.decode()
        return { native: driver.responseEvidence(text), opaque: driver.opaqueEvidence(text) }
      })())
      return response
    } })
    if (proxy !== undefined) registerCleanup(cleanups, proxy, (value) => value.stop(true))
    const selection = { default: { provider: "live", model_id: target.model }, allow: "*" as const }
    const maxOutputTokens = positive("TARDIE_LIVE_MAX_OUTPUT_TOKENS", DEFAULT_LIVE_MAX_OUTPUT_TOKENS)
    const thinkingTokens = positive("TARDIE_LIVE_THINKING_TOKENS", DEFAULT_LIVE_THINKING_TOKENS)
    const config = {
      model: { ...selection, providers: { live: { baseUrl: proxy?.url.toString().replace(/\/$/, "") ?? target.endpoint, protocol: target.protocol, env: ["LIVE_KEY"] } } },
      modelCredentials: { LIVE_KEY: target.apiKey }
    }
    const catalog = { snapshot: { source: "models.dev" as const, revision: target.id, refreshedAt: Date.now(), status: "fresh" as const, providers: [{ id: "live", name: target.id, env: [], models: [{ id: target.model, metadata: { contextWindowTokens: target.contextWindowTokens, maxOutputTokens } }] }] } }
    let nativeSend = overrides.bedrockSend
    if (target.protocol === "bedrock-converse" && nativeSend === undefined) {
      assert.ok(target.region, "Bedrock requires an AWS region")
      const client = new BedrockRuntimeClient({ region: target.region, endpoint: target.endpoint, token: { token: target.apiKey }, authSchemePreference: ["httpBearerAuth"], maxAttempts: 1 })
      registerCleanup(cleanups, client, (value) => value.destroy())
      nativeSend = (input, signal) => client.send(new ConverseStreamCommand(input), { abortSignal: signal })
    }
    const send = nativeSend
    const observedSend: BedrockSend = async (input, signal) => {
      assert.ok(send, "Bedrock transport must be configured")
      await inspectRequest(JSON.stringify(input))
      const response = await send(input, signal)
      const stream = response.stream
      if (stream === undefined) return response
      const observed: ConverseStreamOutput[] = []
      return { ...response, stream: (async function* () {
        try {
          for await (const event of stream) { observed.push(event); yield event }
        } finally {
          const body = JSON.stringify(observed)
          responseEvidence.push(Promise.resolve({ native: driver.responseEvidence(body), opaque: driver.opaqueEvidence(body) }))
        }
      })() }
    }
    const settings = { maxOutputTokens, retry: { backoffMs: [] }, timeout: { attemptMs: timeout } }
    const layers = () => target.protocol === "bedrock-converse"
      ? modelLayerWith(config, catalog, () => inferenceLayer({ ...settings, provider: "bedrock", providerId: "live", endpoint: target.endpoint, client: { send: observedSend }, model: { model: target.model, config: target.behaviors.includes("reasoning") ? { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: thinkingTokens } } } : {} } }).pipe(Layer.provide(FetchHttpClient.layer)))
      : modelLayer(config, catalog, { configure: () => ({ ...settings,
        ...(target.behaviors.includes("reasoning") ? target.protocol === "openai-responses" ? { openai: { store: false, reasoning: { effort: "high" as const } } } : target.protocol === "anthropic-messages" ? { anthropic: { thinking: { type: "enabled" as const, budget_tokens: thinkingTokens } } } : { compat: { reasoning_effort: "high" as const } } : {})
      }) })
    const open = () => createBunHost({ actor: definition(target, events, nonce, () => { toolExecutions++ }), storage, layersFor: layers })
    let host = await open()
    let closeHost = registerCleanup(cleanups, host, (value) => value.close())
    let server = await serve(host, { port: 0 })
    let closeServer = registerCleanup(cleanups, server, (value) => value.close())
    serverUrl = server.url
    const request = (path: string, method: string, body: unknown) => fetch(new URL(path, serverUrl), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal((await request("/v1/actors/main", "PUT", {})).status, 200)
    assert.equal((await request("/v1/actors/main/threads", "POST", { name: "live" })).status, 200)
    const path = "/v1/actors/main/threads/live/methods/message/calls/m1"
    assert.equal((await request(path, "PUT", { text: "Use read_nonce exactly once. Think about why you need the tool. Reply with its nonce exactly." })).status, 202)
    let status = "pending"
    const deadline = Date.now() + timeout
    while (status === "pending" && Date.now() < deadline) {
      const response = await fetch(new URL(path, serverUrl))
      assert.equal(response.status, 200)
      status = (await response.json() as { readonly status: string }).status
      if (status === "pending") await Bun.sleep(100)
    }
    assert.equal(status, "completed", "Live turn must complete")
    assert.equal(toolExecutions, 1, "The nonce tool must execute exactly once")
    assert.ok(followUpChecked, "The provider must receive a follow-up request")
    const evidence = (await Promise.all(responseEvidence)).reduce((total, item) => ({ opaqueParts: total.opaqueParts + item.native.opaqueParts, reasoningTokens: total.reasoningTokens + item.native.reasoningTokens }), { opaqueParts: 0, reasoningTokens: 0 })
    if (target.behaviors.includes("reasoning")) assert.ok(evidence.opaqueParts > 0 || evidence.reasoningTokens > 0, "A reasoning target must return native reasoning evidence")
    const saved = await events()
    assert.ok(saved.some((event) => event.type === "TurnCompleted" && event.output?.includes(nonce)), "The completed output must contain the nonce")
    const requestCount = requests
    await closeServer()
    await closeHost()
    host = await open()
    closeHost = registerCleanup(cleanups, host, (value) => value.close())
    server = await serve(host, { port: 0 })
    closeServer = registerCleanup(cleanups, server, (value) => value.close())
    serverUrl = server.url
    assert.ok(JSON.stringify(await events()) === JSON.stringify(saved), "Events must survive host restart")
    assert.equal((await (await fetch(new URL(path, serverUrl))).json() as { readonly status: string }).status, "completed")
    assert.equal(requests, requestCount, "Restarting a completed call must not infer again")
  } finally { await cleanup(cleanups) }
}
