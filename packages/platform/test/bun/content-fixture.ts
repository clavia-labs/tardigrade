import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { ObjectStorage } from "@clavia/tardigrade-model/object"
import { objectStorageFromFileSystem } from "@clavia/tardigrade-bun"
import { methodResult } from "@clavia/tardigrade-core"
import { createBunHost } from "../../src/bun"
import { contentServices } from "../fixtures/model-services"
import type { ContentFixture } from "../properties/content/hydration"

export async function bunContentFixture(): Promise<ContentFixture> {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-"))
  const objects = objectStorageFromFileSystem(join(root, "objects")).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))
  const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objects)))
  let prompt: Prompt.Prompt | undefined
  let calls = 0
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: join(root, "host"), actorContext,
    services: () => Layer.merge(contentServices(value => { prompt = value; calls++ }), objects),
  }))
  const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
  const resultSchema = methodResult(Schema.Struct({ text: Schema.String }))
  return {
    put: bytes => Effect.runPromise(storage.put(bytes)),
    message: async (content, id) => {
      await Effect.runPromise(thread.invoke("message", { content: [...content] }, { id }))
      return Schema.decodeSync(resultSchema)(await Effect.runPromise(thread.result("message", id)))
    },
    prompt: () => prompt,
    calls: () => calls,
    close: async () => { try { await Effect.runPromise(host.close) } finally { await rm(root, { recursive: true, force: true }) } },
  }
}
