import { expect, test } from "bun:test"
import { Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentMethods, infer, outputValidateOnce } from "@clavia/tardigrade-agent"
import { ModelReturned, TurnFailed } from "@clavia/tardigrade-agent/log/events"
import { inferenceLayer } from "./binding"

for (const provider of ["openai", "anthropic", "openai-compat"] as const) {
  for (const status of [429, 400]) {
    test(`${provider}: structured ${status} failure survives exhaustion and durable replay`, async () => {
      let requests = 0
      const body = { error: { message: "fixture failure", type: status === 429 ? "rate_limit_error" : "invalid_request_error", code: "fixture_code" } }
      const fetch = Object.assign(async () => { requests++; return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0", "x-request-id": "request-1" } }) }, { preconnect: globalThis.fetch.preconnect })
      const definition = actor({ name: "errors", methods: agentMethods, components: [infer([outputValidateOnce], { models: { default: { provider, model_id: "fixture" }, allow: "*" } })] })
      const makeHost = () => createHost({ actorName: "errors", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, inferenceLayer({ provider, endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid", apiKey: Redacted.make("private-fixture-key") }, model: { model: "fixture" }, throttleRetryDelaysMs: [0], retryAfterJitterMs: 0 }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))) })
      const host = makeHost()
      await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Read", at: 1 })
      await host.drive()
      const log = JSON.parse(JSON.stringify(host.read("root")))
      const failure = log.find((event: { type: string }) => event.type === "TurnFailed")
      expect(requests).toBe(status === 429 ? 2 : 1)
      expect(failure).toMatchObject({ attempts: requests, error: {
        code: status === 429 ? "RateLimitError" : "InvalidRequestError", statusCode: status, isRetryable: status === 429,
        details: { _tag: "AiError", reason: { http: { response: { status, headers: { "x-request-id": "request-1", "retry-after": "0" } }, body: JSON.stringify(body) } } }
      } })
      const returned = Schema.decodeUnknownSync(ModelReturned)(log.find((event: { type: string }) => event.type === "ModelReturned"))
      expect(returned.error).toEqual(failure.error)
      expect(JSON.stringify(log)).not.toContain("private-fixture-key")
      expect(Schema.decodeUnknownSync(TurnFailed)(failure)).toMatchObject({ error: failure.error })
      const resumed = makeHost()
      resumed.seed("root", log)
      expect(resumed.read("root").find((event) => event.type === "TurnFailed")).toEqual(failure)
    })
  }
}
