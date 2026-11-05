import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { Model, modelServices, type ModelInput } from "@clavia/tardigrade-agent/services"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { ObjectStorage, ObjectStorageError, type ContentPart } from "@clavia/tardigrade-model/object"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"
import { testStage } from "../fixtures/wait"

const imagePhaseTimeoutMs = 10_000
const imageTestTimeoutMs = 6 * imagePhaseTimeoutMs + 5_000

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

function fixture(phaseTimeoutMs = imagePhaseTimeoutMs) {
  const requests: Array<{ bytes: number; digest: string }> = []
  const timings: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const bytes = new Uint8Array(await request.arrayBuffer())
      JSON.parse(new TextDecoder().decode(bytes))
      requests.push({ bytes: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") })
      return new Response(`data: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    } catch { return new Response("Incomplete request", { status: 400 }) }
  } })
  const run = async (streamFiles: boolean, context: ModelInput["context"], storage: typeof ObjectStorage.Service, beforeSend: (body: RequestInit["body"]) => void) => {
    const mode = streamFiles ? "streamed" : "buffered"
    const sent = Promise.withResolvers<void>()
    const headers = Promise.withResolvers<void>()
    const controller = new AbortController()
    const nativeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      beforeSend(init?.body)
      sent.resolve()
      const result = await fetch(input, init)
      headers.resolve()
      return result
    }, { preconnect: fetch.preconnect })
    const layer = modelServices().pipe(
      Layer.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("fixture"), apiUrl: `http://127.0.0.1:${server.port}`, streamFiles }, model: { model: "fixture" } }).pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provide(Layer.succeed(ModelLock, lock)),
    )
    const pending = Promise.resolve().then(() => Effect.runPromise(Model.use(service => service.call({ model, system: "Inspect images", tools: [], context }, { purpose: "inference", publish: () => Effect.void })).pipe(
      Effect.provide(layer), Effect.provideService(ObjectStorage, storage), Effect.provideService(FetchHttpClient.Fetch, nativeFetch),
    ), { signal: controller.signal }))
    const stage = async <A>(name: string, promise: Promise<A>) => {
      const started = performance.now()
      try { return await testStage(`${mode} ${name}`, () => Promise.race([promise, pending]), phaseTimeoutMs) } finally {
        timings.push(`${mode} ${name}: ${Math.round(performance.now() - started)}ms`)
      }
    }
    try {
      await stage("pre-send (hydration/encoding)", sent.promise)
      await stage("upload/headers", headers.promise)
      return await stage("response consumption", pending)
    } catch (cause) {
      throw new Error(`Image request failed [${timings.join("; ")}]`, { cause })
    } finally {
      controller.abort()
      await pending.catch(() => {})
    }
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
    await run(false, history, storage, () => { expect(reads).toHaveLength(10) })
    reads.length = 0
    await run(true, history, storage, body => {
      expect(body).toBeInstanceOf(ReadableStream)
      expect(reads).toHaveLength(10)
    })
    expect(reads).toHaveLength(10)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(JSON.stringify(history)).toBe(original)
  } finally { stop() }
}, imageTestTimeoutMs)

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
    await expect(run(true, [{ role: "user", content: [file(0), file(1)] }], storage, () => {
      sends++
    })).rejects.toMatchObject({ cause: { cause: { message: "Image missing" } } })
    expect(sends).toBe(0)
    expect(reads).toEqual([file(0).object.digest])
    expect(requests).toHaveLength(0)
  } finally { stop() }
})

test("a stalled image read reports its phase and cancels hydration", async () => {
  const { requests, run, stop } = fixture(100)
  let active = 0
  const storage = ObjectStorage.of({
    put: () => Effect.die("unused"),
    get: () => Effect.acquireUseRelease(
      Effect.sync(() => { active++ }),
      () => Effect.never,
      () => Effect.sync(() => { active-- }),
    ),
  })
  try {
    await expect(run(true, [{ role: "user", content: [file(0)] }], storage, () => {})).rejects.toThrow(/streamed pre-send \(hydration\/encoding\): \d+ms/)
    expect(active).toBe(0)
    expect(requests).toHaveLength(0)
  } finally { stop() }
})
