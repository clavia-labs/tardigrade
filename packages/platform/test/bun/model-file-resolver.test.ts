import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Model, ModelFileResolver, liveModelServices, type ModelInput } from "../../../agent/src/services/model"
import { Conversation } from "../../../agent/src/contracts/events"
import { layerModelLock } from "../../../model/src/lock"
import { makeObjectStorage, ObjectStorage } from "../../../model/src/object"
import { providerLayer } from "../../../model/src/providers/openai"
import { RuntimeError } from "../../../core/src/runtime/effects"

type Image = { readonly type: string; readonly image_url?: string }
type RequestBody = { readonly input: readonly { readonly role?: string; readonly type?: string; readonly content?: readonly Image[]; readonly output?: string | readonly Image[] }[] }

const fixture = async () => {
  const model = { provider: "fixture", model_id: "fixture" }
  const objects = new Map<string, Uint8Array>()
  const requests: RequestBody[] = []
  let reads = 0
  const storage = makeObjectStorage({
    read: key => Effect.sync(() => { reads++; return objects.get(key) }),
    write: (key, bytes) => Effect.sync(() => { objects.set(key, new Uint8Array(bytes)) }),
  })
  const bytes = new Uint8Array([0, 127, 255])
  const reference = await Effect.runPromise(storage.put(bytes))
  const image = { type: "file", object: reference, mediaType: "image/png", filename: "image.png" }
  const input: ModelInput = { model, system: "", tools: [], context: Schema.decodeUnknownSync(Conversation)([
    { role: "user", content: [{ type: "text", text: "Before" }, image, { ...image, mediaType: "image/jpeg" }, { type: "text", text: "After" }] },
    { role: "assistant", text: "", toolCalls: [{ callId: "read", providerId: "read", name: "read", input: {} }] },
    { role: "tool", callId: "read", providerId: "read", name: "read", text: "Image", error: false, content: [image] },
  ]) }
  const fetch = Object.assign(async (_: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as RequestBody)
    return Response.json({ id: "response", object: "response", created_at: 0, status: "completed", model: "fixture", output: [
      { id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] },
    ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
  }, { preconnect: globalThis.fetch.preconnect })
  const layer = liveModelServices({ credentials: { FIXTURE_KEY: "fixture" }, providerLayer }).pipe(Layer.provide(layerModelLock({
    schema: 2, providers: { fixture: { protocol: "openai-responses", baseUrl: "https://provider.example.test/v1", env: ["FIXTURE_KEY"] } },
    models: [{ ...model, contextWindowTokens: 4096 }],
  }, { allow: "*", default: model })))
  const call = (resolver?: typeof ModelFileResolver.Service, hydrate = true) => {
    const request = Model.use(service => service.call(input)).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch))
    const resolved = resolver ? request.pipe(Effect.provideService(ModelFileResolver, resolver)) : request
    return Effect.runPromise(hydrate ? resolved.pipe(Effect.provideService(ObjectStorage, storage)) : resolved)
  }
  return { bytes, reference, input, objects, requests, call, reads: () => reads,
    images: () => requests.at(-1)?.input.flatMap(item => [...(item.content ?? []), ...(Array.isArray(item.output) ? item.output as readonly Image[] : [])].filter(part => part.type === "input_image")) ?? [],
  }
}

test("file resolution renders user and tool URLs through the native provider without storage reads", async () => {
  const current = await fixture()
  const original = structuredClone(current.input)
  const resolved: string[] = []
  const reply = await current.call({ resolve: (file, model) => Effect.sync(() => {
    expect(model).toEqual(current.input.model)
    resolved.push(file.mediaType)
    return new URL(`https://files.example.test/${file.object.digest}?media_type=${file.mediaType}`)
  }) }, false)
  expect(reply.text).toBe("ok")
  expect(resolved).toEqual(["image/png", "image/jpeg"])
  expect(current.reads()).toBe(0)
  expect(current.images().map(image => image.image_url)).toEqual(["image/png", "image/jpeg", "image/png"].map(mediaType => new URL(`https://files.example.test/${current.reference.digest}?media_type=${mediaType}`).href))
  expect(current.requests[0]?.input[1]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "Before" }, { type: "input_image" }, { type: "input_image" }, { type: "input_text", text: "After" }] })
  expect(current.input).toEqual(original)
})

test("an absent resolver preserves deduplicated native byte hydration", async () => {
  const current = await fixture()
  await current.call()
  expect(current.reads()).toBe(1)
  expect(current.images().map(image => image.image_url)).toEqual([
    "data:image/png;base64,AH//", "data:image/jpeg;base64,AH//", "data:image/png;base64,AH//",
  ])
})

test("undefined resolution hydrates only the remaining file media types", async () => {
  const current = await fixture()
  await current.call({ resolve: file => Effect.succeed(file.mediaType === "image/png" ? new URL("https://files.example.test/image.png") : undefined) })
  expect(current.reads()).toBe(1)
  expect(current.images().map(image => image.image_url)).toEqual([
    "https://files.example.test/image.png", "data:image/jpeg;base64,AH//", "https://files.example.test/image.png",
  ])
})

test("resolver failures stop before object hydration and provider invocation", async () => {
  const current = await fixture()
  await expect(current.call({ resolve: () => Effect.fail(new RuntimeError("Reference unavailable")) })).rejects.toThrow("Reference unavailable")
  expect(current.reads()).toBe(0)
  expect(current.requests).toHaveLength(0)
})

test("undefined resolution retains native object integrity verification", async () => {
  const current = await fixture()
  current.objects.set(`sha256:${current.reference.digest}`, new Uint8Array([1]))
  await expect(current.call({ resolve: () => Effect.void.pipe(Effect.as(undefined)) })).rejects.toThrow("Object digest does not match its bytes")
  expect(current.reads()).toBe(1)
  expect(current.requests).toHaveLength(0)
})
