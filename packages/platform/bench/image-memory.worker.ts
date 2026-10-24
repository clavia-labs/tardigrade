import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"
import { ObjectStorage } from "@clavia/tardigrade-model/object/storage"
import { Model, modelServices } from "@clavia/tardigrade-agent/services"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"

const checkpoint = (stage: string) => {
  Object.assign(globalThis, { imageMemoryStage: stage })
  // eslint-disable-next-line no-debugger -- Inspector pauses provide allocation-stage measurements.
  debugger
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const count = Number(url.searchParams.get("count"))
    const bytes = Number(url.searchParams.get("bytes"))
    const endpoint = url.searchParams.get("endpoint")!
    const transport = url.searchParams.get("transport") === "url" ? "url" : "inline"
    checkpoint("baseline")
    const content = Array.from({ length: count }, (_, index) => ({
      type: "file" as const, mediaType: "image/png", byteSize: bytes, object: { algorithm: "sha256" as const, digest: index.toString(16).padStart(64, "0") },
    }))
    let imageReads = 0
    const storage = ObjectStorage.of({
      get: reference => Effect.sync(() => {
        imageReads++
        if (transport === "url") throw new Error("URL requests must not hydrate image bytes")
        return Uint8Array.from({ length: bytes }, (_, at) => (at + Number.parseInt(reference.digest, 16)) % 256)
      }),
      put: () => Effect.die("unused"),
      url: reference => Effect.succeed(new URL(`${endpoint}/images/${Number.parseInt(reference.digest, 16)}?bytes=${bytes}`)),
    })
    const nativeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      checkpoint("json-body")
      const response = await fetch(input, init)
      checkpoint("http-sent")
      return response
    }, { preconnect: fetch.preconnect })
    const model = { provider: "gateway", model_id: "fixture" }
    const lock = modelLockService(modelLockOf({ schema: 2,
      providers: { gateway: { protocol: "openai-responses", baseUrl: endpoint, env: ["KEY"] } },
      models: [{ ...model, contextWindowTokens: 128000 }],
    }), { allow: "*", default: model })
    const layer = modelServices({ imageTransport: transport }).pipe(
      Layer.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("fixture"), apiUrl: endpoint }, model: { model: "fixture" } }).pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provide(Layer.succeed(ModelLock, lock)),
    )
    try {
      await Effect.runPromise(Model.use(service => service.call({ model, system: "Inspect images", tools: [], context: [{ role: "user", content }] }, { purpose: "inference", publish: () => Effect.void })).pipe(
        Effect.provide(layer), Effect.provideService(ObjectStorage, storage), Effect.provideService(FetchHttpClient.Fetch, nativeFetch),
      ))
    } catch (error) {
      return new Response(JSON.stringify(error, Object.getOwnPropertyNames(error)), { status: 500 })
    }
    return Response.json({ count, imageBytes: count * bytes, imageReads })
  },
}
