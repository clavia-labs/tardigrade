import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { ObjectStorage } from "@clavia/tardigrade-model/object"
import { objectStorageFromFileSystem } from "@clavia/tardigrade-bun"
import { methodResult, RuntimeError } from "@clavia/tardigrade-core"
import { createBunHost } from "../../../src/bun"
import { agentDurableAtoms } from "@clavia/tardigrade-agent/atoms/durable"
import { contentServices } from "../agent"
import type { ContentFixture } from "../../properties/content/hydration"

export async function bunContentFixture(): Promise<ContentFixture & { readonly reopen: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-"))
  const objects = objectStorageFromFileSystem(join(root, "objects")).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))
  const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objects)))
  let prompt: Prompt.Prompt | undefined
  let calls = 0
  const open = () => createBunHost({ actor: createActor, storage: join(root, "host"), actorContext, initialStateAtoms: agentDurableAtoms, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } },
    services: () => Layer.merge(contentServices(value => { prompt = value; calls++ }), objects),
  })
  let host = await Effect.runPromise(open())
  let thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
  const resultSchema = methodResult(Schema.Struct({ text: Schema.String }))
  return {
    put: bytes => Effect.runPromise(storage.put(bytes)),
    message: async (content, id) => {
      await Effect.runPromise(thread.invoke("message", { content: [...content] }, { id }))
      return Schema.decodeSync(resultSchema)(await Effect.runPromise(thread.result("message", id)))
    },
    reopen: () => Effect.runPromise(Effect.gen(function* () {
      yield* thread.wait
      const coordinate = thread.coordinate
      yield* host.close
      host = yield* open()
      const restored = yield* host.getThread(coordinate)
      if (!restored) return yield* Effect.fail(new RuntimeError("Expected the original agent journal"))
      thread = restored
    })),
    prompt: () => prompt,
    calls: () => calls,
    close: async () => { try { await Effect.runPromise(host.close) } finally { await rm(root, { recursive: true, force: true }) } },
  }
}
