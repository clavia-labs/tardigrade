import { assertHydratedContent } from "../agent/content-property"
import { Prompt } from "effect/unstable/ai"
import { contentServices } from "../agent/services"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { ObjectStorage } from "@clavia/tardigrade-model/object"
import { objectStorageFromFileSystem } from "@clavia/tardigrade-bun"
import { createBunHost } from "../../src/bun"

const objectLayer = (directory: string) => objectStorageFromFileSystem(directory).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

test("Bun host replays durable content into the provider as hydrated parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-"))
  const hostDirectory = join(root, "host")
  const objectDirectory = join(root, "objects")
  let observed: Prompt.Prompt | undefined
  const objectStorage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objectLayer(objectDirectory))))
  const bytes = new TextEncoder().encode("photo")
  const reference = await Effect.runPromise(objectStorage.put(bytes))
  const services = () => Layer.merge(contentServices(prompt => { observed = prompt }), objectLayer(objectDirectory))
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: hostDirectory, actorContext, services }))
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
    const reply = await Effect.runPromise(thread.methods.message({ content: [
      { type: "text", text: "Before" },
      { type: "file", mediaType: "image/png", filename: "photo.png", object: reference },
      { type: "text", text: "After" },
    ] }, { id: "message" }))
    expect(reply).toEqual({ text: "ok" })
    assertHydratedContent(observed, bytes)
  } finally {
    await Effect.runPromise(host.close)
    await rm(root, { recursive: true, force: true })
  }
})

test("Bun host fails before provider execution when an object is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-missing-"))
  let providerCalls = 0
  const services = () => Layer.merge(contentServices(() => { providerCalls++ }), objectLayer(join(root, "objects")))
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: join(root, "host"), actorContext, services }))
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
    const reference = { algorithm: "sha256" as const, digest: "a".repeat(64) }
    await expect(Effect.runPromise(thread.methods.message({ content: [{ type: "file", mediaType: "image/png", object: reference }] }, { id: "missing" }))).rejects.toThrow("Object is missing")
    expect(providerCalls).toBe(0)
  } finally {
    await Effect.runPromise(host.close)
    await rm(root, { recursive: true, force: true })
  }
})
