import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { actorFromProjections } from "@clavia/tardigrade-core/runtime/definition"
import { MessageContent, AgentMessageReceived } from "../log/message"
import { ObjectStorage } from "../object/storage"
import { objectStorageFromKeyValueStore } from "../object/key-value"
import { receive } from "./turn"

const receiver = actorFromProjections({ transitions: [], keyOf: () => undefined })
const memoryLog = Layer.effect(EventLog, Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<Event>>([])
  return withWatermark({
    read: Ref.get(events),
    append: (batch) => Ref.update(events, (current) => [...current, ...batch])
  })
}))

describe("reference message receipt", () => {
  test("records uploaded references once and resolves replayed content from the same store", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const storage = yield* ObjectStorage
      const log = yield* EventLog
      const bytes = new TextEncoder().encode("%PDF-1.7 test document")
      const object = yield* storage.put(bytes)
      const content: MessageContent = [
        { type: "text", text: "Read this report" },
        { type: "file", mediaType: "application/pdf", filename: "q1.pdf", object }
      ]
      yield* receive(receiver, { id: "m1", content, input: { account: "test" } })
      yield* receive(receiver, { id: "m1", content: [{ type: "text", text: "retry must not replace the original" }] })
      const events = yield* log.read
      expect(events).toHaveLength(1)
      const replay = yield* Schema.decodeUnknownEffect(AgentMessageReceived)(JSON.parse(JSON.stringify(events[0])))
      expect(replay).toMatchObject({ type: "MessageReceived", id: "m1", content, input: { account: "test" } })
      expect("text" in replay).toBe(false)
      const attachment = replay.content?.[1]
      if (attachment?.type !== "file") throw new Error("missing replayed attachment")
      expect(yield* storage.get(attachment.object)).toEqual(bytes)
    }).pipe(
      Effect.provide(Layer.merge(
        memoryLog,
        objectStorageFromKeyValueStore().pipe(Layer.provide(KeyValueStore.layerMemory))
      ))
    ))
  })

  test("receives legacy text without any storage service", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      yield* receive(receiver, { id: "legacy", text: "Hello" })
      const log = yield* EventLog
      const events = yield* log.read
      expect(events).toHaveLength(1)
      expect(yield* Schema.decodeUnknownEffect(AgentMessageReceived)(events[0])).toMatchObject({
        type: "MessageReceived", id: "legacy", text: "Hello"
      })
    }).pipe(Effect.provide(memoryLog)))
  })
})
