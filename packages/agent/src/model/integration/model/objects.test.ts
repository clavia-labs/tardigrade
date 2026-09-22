import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { inferenceLayer } from "@clavia/tardigrade-model/services"
import { ObjectReadConcurrency, ObjectStorage } from "../../../object/storage"
import { objectKeyOf, objectRefOf } from "../../../object/reference"
import { DEFAULT_OBJECT_STORAGE_PREFIX, objectStorageFromKeyValueStore } from "../../../object/key-value"
import { react } from "../../execution/index"

const fixture = () => {
  const requests: Array<{ input: Array<{ role: string; content: unknown }> }> = []
  const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(await new Response(init?.body).text()))
    const item = { id: "answer", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Read it", annotations: [] }] }
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "answer", delta: "Read it" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response", status: "completed", created_at: 1, model: "fixture", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
    ]
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const layer = inferenceLayer({
    provider: "openai", endpoint: "https://fixture.invalid", client: { apiUrl: "https://fixture.invalid" },
    model: { model: "fixture" }, retry: { backoffMs: [] }
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return { requests, layer }
}

const request = (trajectory: ReadonlyArray<Event>) => ({
  identity: { actor: "reader", instance: "test", thread: "root", turn: "active" },
  system: "Read the attachments", trajectory, tools: []
})

describe("objects at the model boundary", () => {
  test("sends selected bytes in order, reuses duplicate objects, and leaves durable references intact", async () => {
    const { requests, layer } = fixture()
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      const pdf = new TextEncoder().encode("%PDF-1.7 test")
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const document = yield* storage.put(pdf)
      const image = yield* storage.put(png)
      const absent = yield* objectRefOf(new Uint8Array([255]))
      const trajectory: ReadonlyArray<Event> = [
        { type: "MessageReceived", id: "old", content: [{ type: "file", mediaType: "image/png", object: absent }], at: 0 },
        { type: "TurnCompleted", turn: "old", output: "done", at: 1 },
        { type: "MessageReceived", id: "active", content: [
          { type: "text", text: "Compare" },
          { type: "file", mediaType: "application/pdf", filename: "q1.pdf", object: document },
          { type: "text", text: "with this" },
          { type: "file", mediaType: "image/png", object: image },
          { type: "file", mediaType: "application/pdf", filename: "copy.pdf", object: document }
        ], at: 2 },
        { type: "CompactionCompleted", keepFrom: "m:active", summary: "Old work", at: 3 }
      ]
      const before = JSON.stringify(trajectory)
      const reads: string[] = []
      const completed: string[] = []
      const imageRead = yield* Deferred.make<void>()
      const result = yield* react(request(trajectory)).pipe(
        Effect.provideService(ObjectReadConcurrency, 2),
        Effect.provideService(ObjectStorage, {
          put: storage.put,
          get: (reference) => Effect.gen(function* () {
            const key = objectKeyOf(reference)
            reads.push(key)
            if (key === objectKeyOf(document)) yield* Deferred.await(imageRead)
            const bytes = yield* storage.get(reference)
            completed.push(key)
            if (key === objectKeyOf(image)) yield* Deferred.succeed(imageRead, undefined)
            return bytes
          })
        })
      )
      expect(result).toMatchObject({ kind: "complete", output: "Read it" })
      expect(reads).toEqual([objectKeyOf(document), objectKeyOf(image)])
      expect(completed).toEqual([objectKeyOf(image), objectKeyOf(document)])
      expect(JSON.stringify(trajectory)).toBe(before)
      expect(requests).toHaveLength(1)
      const user = requests[0]?.input.filter((message) => message.role === "user").at(-1)
      expect(user?.content).toEqual([
        { type: "input_text", text: "Compare" },
        { type: "input_file", filename: "q1.pdf", file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` },
        { type: "input_text", text: "with this" },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, detail: "auto" },
        { type: "input_file", filename: "copy.pdf", file_data: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}` }
      ])
    }).pipe(Effect.provide(Layer.merge(layer, objectStorageFromKeyValueStore().pipe(Layer.provide(KeyValueStore.layerMemory))))))
  })

  for (const state of ["unavailable", "missing", "corrupt"] as const) {
    test(`fails before contacting the provider when object storage is ${state}`, async () => {
      const { requests, layer } = fixture()
      await Effect.runPromise(Effect.gen(function* () {
        const reference = yield* objectRefOf(new Uint8Array([1, 2, 3]))
        const inference = react(request([{
          type: "MessageReceived", id: "active", at: 0,
          content: [{ type: "file", mediaType: "image/png", object: reference }]
        }]))
        const result = state === "unavailable" ? yield* inference : yield* Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore
          if (state === "corrupt") yield* kv.set(DEFAULT_OBJECT_STORAGE_PREFIX + objectKeyOf(reference), new Uint8Array([0]))
          return yield* inference.pipe(Effect.provide(objectStorageFromKeyValueStore()))
        }).pipe(Effect.provide(KeyValueStore.layerMemory))
        expect(result).toMatchObject({ kind: "fail", retryable: false, failure: { cause: "inference_error" } })
        expect(requests).toHaveLength(0)
      }).pipe(Effect.provide(layer)))
    })
  }
})
