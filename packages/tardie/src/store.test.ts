import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ObjectStorage, makeObjectStorage } from "tardie/store"
import { ObjectStorage as ModelObjectStorage } from "@clavia/tardigrade-model/object"

test("model content helpers consume the shared store service", async () => {
  const objects = new Map<string, Uint8Array>()
  const store = makeObjectStorage({
    read: key => Effect.sync(() => objects.get(key)),
    write: (key, bytes) => Effect.sync(() => { objects.set(key, bytes) }),
  })
  const bytes = new Uint8Array([0, 255, 128, 1])
  const content = await Effect.runPromise(ModelObjectStorage.persist([
    { type: "text", text: "image" },
    { type: "file", mediaType: "image/png", filename: "page.png", bytes },
  ]).pipe(Effect.provideService(ObjectStorage, store)))
  const file = content[1]!
  expect(file.type).toBe("file")
  if (file.type === "file") {
    expect(file).toMatchObject({ filename: "page.png", mediaType: "image/png", byteSize: 4 })
    expect([...await Effect.runPromise(store.get(file.object))]).toEqual([...bytes])
  }
  const resolved = await Effect.runPromise(ModelObjectStorage.resolve(content).pipe(Effect.provideService(ObjectStorage, store)))
  expect(resolved).toEqual([{ type: "text", text: "image" }, { type: "file", mediaType: "image/png", filename: "page.png", byteSize: 4, bytes }])
})
