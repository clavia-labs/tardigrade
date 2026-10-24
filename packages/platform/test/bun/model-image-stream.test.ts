import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Model, modelServices, type ModelInput } from "@clavia/tardigrade-agent/services"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { ObjectStorage, ObjectStorageError, type ContentPart } from "@clavia/tardigrade-model/object"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"

const file = (index: number): Extract<ContentPart, { type: "file" }> => ({
  type: "file", mediaType: "image/png", byteSize: 512 * 1024,
  object: { algorithm: "sha256", digest: index.toString(16).padStart(64, "0") },
})
const imageBytes = (index: number) => Uint8Array.from({ length: 512 * 1024 }, (_, offset) => (index + offset) % 256)
const model = { provider: "gateway", model_id: "fixture" }
const lock = modelLockService(modelLockOf({ schema: 2,
  providers: { gateway: { protocol: "openai-responses", baseUrl: "https://fixture.invalid", env: ["KEY"] } },
  models: [{ ...model, contextWindowTokens: 128000 }],
}), { allow: "*", default: model })
const response = { id: "fixture", created_at: 1, model: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }

function fixture() {
  const requests: Array<{ bytes: number; digest: string }> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const bytes = new Uint8Array(await request.arrayBuffer())
      JSON.parse(new TextDecoder().decode(bytes))
      requests.push({ bytes: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") })
      return new Response(`data: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    } catch { return new Response("Incomplete request", { status: 400 }) }
  } })
  const run = (streamFiles: boolean, context: ModelInput["context"], storage: typeof ObjectStorage.Service, beforeSend: (body: RequestInit["body"]) => void) => {
    const nativeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      beforeSend(init?.body)
      return fetch(input, init)
    }, { preconnect: fetch.preconnect })
    const layer = modelServices().pipe(
      Layer.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("fixture"), apiUrl: `http://127.0.0.1:${server.port}`, streamFiles }, model: { model: "fixture" } }).pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provide(Layer.succeed(ModelLock, lock)),
    )
    return Model.use(service => service.call({ model, system: "Inspect images", tools: [], context }, { purpose: "inference", publish: () => Effect.void })).pipe(
      Effect.provide(layer), Effect.provideService(ObjectStorage, storage), Effect.provideService(FetchHttpClient.Fetch, nativeFetch),
    )
  }
  return { requests, run, stop: () => server.stop(true) }
}

test("provider streaming preserves buffered HTTP bytes after verified hydration", async () => {
  const { requests, run, stop } = fixture()
  const files = Array.from({ length: 10 }, (_, index) => file(index))
  const history: ModelInput["context"] = [
    { role: "user", content: [{ type: "text", text: "Inspect \"quotes\", \\slashes, and\nnewlines: café 한글" }, ...files.slice(0, 5)] },
    { role: "assistant", text: "", toolCalls: [{ callId: "call", providerId: "call", name: "read", input: {} }] },
    { role: "tool", callId: "call", providerId: "call", name: "read", text: "Images", error: false, content: [{ type: "text", text: "Images" }, ...files.slice(5)] },
  ]
  const original = JSON.stringify(history)
  const reads: string[] = []
  const storage = ObjectStorage.of({
    put: () => Effect.die("unused"),
    get: reference => Effect.sync(() => { reads.push(reference.digest); return imageBytes(Number.parseInt(reference.digest, 16)) }),
    url: () => Effect.die("Inline requests must not resolve URLs"),
  })
  try {
    await Effect.runPromise(run(false, history, storage, () => { expect(reads).toHaveLength(10) }))
    reads.length = 0
    await Effect.runPromise(run(true, history, storage, body => {
      expect(body).toBeInstanceOf(ReadableStream)
      expect(reads).toHaveLength(10)
    }))
    expect(reads).toHaveLength(10)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(JSON.stringify(history)).toBe(original)
  } finally { stop() }
})

test("object failure stops before streaming an HTTP request", async () => {
  const { requests, run, stop } = fixture()
  let sends = 0
  const reads: string[] = []
  const storage = ObjectStorage.of({
    put: () => Effect.die("unused"),
    get: reference => Effect.suspend(() => {
      reads.push(reference.digest)
      return Effect.fail(new ObjectStorageError({ reason: "Missing", reference, message: "Image missing" }))
    }),
  })
  try {
    const result = await Effect.runPromise(run(true, [{ role: "user", content: [file(0), file(1)] }], storage, () => {
      sends++
    }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(sends).toBe(0)
    expect(reads).toEqual([file(0).object.digest])
    expect(requests).toHaveLength(0)
  } finally { stop() }
})
