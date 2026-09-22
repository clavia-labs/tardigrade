import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { expect, test } from "bun:test"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { createHost } from "@clavia/tardigrade-host/host"
import { fixtureModelLayer as modelLayer } from "@clavia/tardigrade-model/testing/host"
import { modelConfigOf } from "@clavia/tardigrade-model/config"
import { agentMethods, infer, nativeOutput, NativeOutputSupport } from "../src/index"

for (const structured of [false, true]) test(`host fallback crosses the provider boundary without weakening output guarantees (structured: ${structured})`, async () => {
  const primary = { provider: "primary", model_id: "model" }
  const secondary = { provider: "secondary", model_id: "model" }
  const model = modelConfigOf({ default: primary, fallback: [secondary], allow: "*", providers: Object.fromEntries([primary, secondary].map(ref => [ref.provider, { baseUrl: `https://${ref.provider}.invalid/v1`, protocol: "openai-chat-completions", env: ["KEY"] }])) })
  const requested: string[] = []
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input)
    requested.push(url)
    if (url.includes("primary")) return Response.json({ error: { message: "Region unavailable", type: "invalid_request_error", code: "unsupported_region" } }, { status: 400 })
    return new Response('data: {"id":"response","created":1,"model":"model","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\ndata: {"id":"response","created":1,"model":"model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const layer = modelLayer({ model, modelCredentials: { KEY: "test" } }, { snapshot: { source: "models.dev", revision: "fixture", refreshedAt: 1, status: "fresh", providers: [primary, secondary].map(ref => ({ id: ref.provider, name: ref.provider, env: [], models: [{ id: ref.model_id, metadata: { contextWindowTokens: 128000 } }] })) } }, {
    configure: selected => ({ retry: { backoffMs: [] }, ...(selected.provider === primary.provider ? { output: { guarantee: "native", withTools: true } } : {}) })
  })
  const definition = actor({ name: "fallback", methods: agentMethods, components: [infer([nativeOutput])] })
  const host = createHost({ actorName: "fallback", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, layer, Layer.succeed(FetchHttpClient.Fetch, fetch), Layer.succeed(NativeOutputSupport, { withTools: true })) })
  await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "Hello", ...(structured ? { output: { name: "answer", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } } : {}), at: 1 })
  await host.drive()
  expect(requested).toEqual(structured ? ["https://primary.invalid/v1/chat/completions"] : ["https://primary.invalid/v1/chat/completions", "https://secondary.invalid/v1/chat/completions"])
  const events = host.read("root")
  expect(events.filter(e => e.type === "ModelCalled").map(e => e.model)).toEqual([primary, secondary])
  expect(events.filter(e => e.type === "ModelReturned").map(e => e.outcome)).toEqual(["failed", structured ? "failed" : "returned"])
  expect(events.filter(e => e.type === (structured ? "TurnFailed" : "TurnCompleted"))).toHaveLength(1)
  if (structured) expect(events.find(e => e.type === "TurnFailed")?.cause).toBe("output_unsupported")
})
