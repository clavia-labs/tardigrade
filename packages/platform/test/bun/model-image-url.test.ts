import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Model, modelServices, type ModelInput, type ModelServiceOptions } from "@clavia/tardigrade-agent/services"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { ObjectStorage, ObjectStorageError, makeObjectStorage, cachedObjectStorage, type ContentPart } from "@clavia/tardigrade-model/object"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai"

const file = (index: number, mediaType = "image/png"): Extract<ContentPart, { type: "file" }> => ({
  type: "file", mediaType, filename: `image-${index}`, byteSize: 512 * 1024,
  object: { algorithm: "sha256", digest: index.toString(16).padStart(64, "0") },
})
const imageUrl = (part: Extract<ContentPart, { type: "file" }>) => new URL(`https://images.example.test/sha256/${part.object.digest}?media_type=${encodeURIComponent(part.mediaType)}`)

function fixture(modelId = "openai/fixture", options: ModelServiceOptions = { imageTransport: "url" }) {
  const bodies: Array<{ input: unknown[] }> = []
  const byteLengths: number[] = []
  const model = { provider: "gateway", model_id: modelId }
  const lock = modelLockService(modelLockOf({ schema: 2,
    providers: { gateway: { protocol: "openai-responses", baseUrl: "https://gateway.example.test", env: ["KEY"] } },
    models: [{ ...model, contextWindowTokens: 128000 }],
  }), { allow: "*", default: model })
  const http = HttpClient.make(request => Effect.sync(() => {
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request")
    byteLengths.push(request.body.body.byteLength)
    bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)))
    const response = { id: "fixture", created_at: 1, model: modelId, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
    return HttpClientResponse.fromWeb(request, new Response(`data: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`, { headers: { "content-type": "text/event-stream" } }))
  }))
  const layer = modelServices(options).pipe(
    Layer.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("fixture") }, model: { model: modelId } }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))),
    Layer.provide(Layer.succeed(ModelLock, lock)),
  )
  const run = (context: ModelInput["context"], storage: typeof ObjectStorage.Service) => {
    let call = Model.use(service => service.call({ model, system: "Inspect images", tools: [], context }, { purpose: "inference", publish: () => Effect.void })).pipe(Effect.provide(layer))
    call = call.pipe(Effect.provideService(ObjectStorage, storage))
    return Effect.runPromise(call)
  }
  return { model, bodies, byteLengths, layer, run }
}

for (const modelId of ["openai/fixture", "anthropic/fixture"]) {
  test(`Responses renders ten image references without object reads (${modelId})`, async () => {
    const { bodies, byteLengths, run } = fixture(modelId)
    const files = Array.from({ length: 10 }, (_, index) => file(index))
    const context: ModelInput["context"] = files.map(part => ({ role: "user", content: [part] }))
    const original = JSON.stringify(context)
    const resolved: string[] = []
    const storage = cachedObjectStorage(makeObjectStorage({
      read: () => Effect.die("Image URL requests must not read bytes"),
      write: () => Effect.die("unused"),
      url: (key, options) => Effect.sync(() => {
        resolved.push(key)
        return imageUrl({ ...files.find(part => key.endsWith(part.object.digest))!, mediaType: options!.mediaType! })
      }),
    }), {
      policy: { maxCachedObjectBytes: 1024, maxCacheBytes: 1024 },
      get: () => Effect.die("Image URL requests must not read cached bytes"),
      put: () => Effect.die("Image URL requests must not cache bytes"),
      remove: () => Effect.die("Image URL requests must not evict cached bytes"),
    })
    await run(context, storage)
    await run([...context, { role: "tool", callId: "call", providerId: "call", name: "read", text: "Image", error: false, content: [files[0]!] }], storage)
    expect(resolved).toHaveLength(20)
    expect(bodies[0]!.input).toHaveLength(11)
    expect(bodies[1]!.input.slice(0, 11)).toEqual(bodies[0]!.input)
    expect(bodies[1]!.input.at(-1)).toMatchObject({ type: "function_call_output", output: [{ type: "input_image", image_url: imageUrl(files[0]!).href }] })
    for (const [index, part] of files.entries()) expect(bodies[0]!.input[index + 1]).toMatchObject({ role: "user", content: [{ type: "input_image", image_url: imageUrl(part).href }] })
    expect(byteLengths.every(length => length < 5000)).toBe(true)
    expect(JSON.stringify(context)).toBe(original)
  })
}

test("image URLs preserve media types while documents use verified byte hydration", async () => {
  const { bodies, run } = fixture()
  const png = file(0), jpeg = file(0, "image/jpeg"), pdf = file(1, "application/pdf")
  const reads: string[] = []
  const storage = ObjectStorage.of({ put: () => Effect.die("unused"), get: reference => Effect.sync(() => { reads.push(reference.digest); return new Uint8Array([1, 2, 3]) }), url: (reference, options) => Effect.succeed(imageUrl({ ...png, object: reference, mediaType: options!.mediaType! })) })
  await run([{ role: "user", content: [png, jpeg, pdf] }], storage)
  expect(reads).toEqual([pdf.object.digest])
  expect(bodies[0]!.input[1]).toMatchObject({ content: [
    { type: "input_image", image_url: imageUrl(png).href },
    { type: "input_image", image_url: imageUrl(jpeg).href },
    { type: "input_file", file_data: "data:application/pdf;base64,AQID" },
  ] })
})

test("URL failure stops before byte hydration or provider execution", async () => {
  const { bodies, run } = fixture()
  let reads = 0
  const storage = ObjectStorage.of({ put: () => Effect.die("unused"), get: () => Effect.sync(() => { reads++; return new Uint8Array([1]) }), url: reference => Effect.fail(new ObjectStorageError({ reason: "Unavailable", reference, message: "Image URL unavailable" })) })
  await expect(run([{ role: "user", content: [file(0)] }], storage)).rejects.toThrow("Image URL unavailable")
  expect(reads).toBe(0)
  expect(bodies).toHaveLength(0)
})

test("unconfigured file resolution retains inline image requests", async () => {
  const { bodies, run } = fixture("openai/fixture", {})
  await run([{ role: "user", content: [file(0)] }], ObjectStorage.of({
    put: () => Effect.die("unused"), get: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    url: () => Effect.die("Inline transport must not resolve URLs"),
  }))
  expect(bodies[0]!.input[1]).toMatchObject({ content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] })
})

test("URL transport requires a URL-capable store before reading image bytes", async () => {
  const { bodies, run } = fixture()
  await expect(run([{ role: "user", content: [file(0)] }], ObjectStorage.of({
    put: () => Effect.die("unused"), get: () => Effect.die("URL transport must not fall back to bytes"),
  }))).rejects.toThrow("Image URL transport requires ObjectStorage.url")
  expect(bodies).toHaveLength(0)
})

test("a shared model service selects image transport for each call", async () => {
  let transport: "inline" | "url" = "inline"
  const { model, bodies, layer } = fixture("openai/fixture", { imageTransport: selected => Effect.sync(() => {
    expect(selected).toEqual(model)
    return transport
  }) })
  let reads = 0, urls = 0
  const storage = ObjectStorage.of({
    put: () => Effect.die("unused"),
    get: () => Effect.sync(() => { reads++; return new Uint8Array([1, 2, 3]) }),
    url: reference => Effect.sync(() => { urls++; return imageUrl({ ...file(0), object: reference }) }),
  })
  const input: ModelInput = { model, system: "Inspect images", tools: [], context: [{ role: "user", content: [file(0)] }] }
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* Model
    for (const mode of ["inline", "url", "inline"] as const) {
      transport = mode
      yield* service.call(input, { purpose: "inference", publish: () => Effect.void })
    }
  }).pipe(Effect.provide(layer), Effect.provideService(ObjectStorage, storage)))
  expect(reads).toBe(2)
  expect(urls).toBe(1)
  expect(bodies[0]!.input).toEqual(bodies[2]!.input)
  expect(bodies[1]!.input[1]).toMatchObject({ content: [{ type: "input_image", image_url: imageUrl(file(0)).href }] })
})

test("image transport selection leaves text and document-only calls unchanged", async () => {
  const { bodies, run } = fixture("openai/fixture", { imageTransport: () => Effect.die("No image route is required") })
  const storage = ObjectStorage.of({ put: () => Effect.die("unused"), get: () => Effect.succeed(new Uint8Array([1, 2, 3])) })
  await run([{ role: "user", text: "Inspect the document" }], storage)
  await run([{ role: "user", content: [file(0, "application/pdf")] }], storage)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]!.input[1]).toMatchObject({ content: [{ type: "input_file", file_data: "data:application/pdf;base64,AQID" }] })
})
