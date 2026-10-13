import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { ObjectStorage } from "@clavia/tardigrade-model/object"
import { objectStorageFromFileSystem } from "@clavia/tardigrade-bun"
import { decodeCheckpoint, methodResult, RuntimeError } from "@clavia/tardigrade-core"
import { bunJournal, createBunHost } from "../../../src/bun"
import { agentDurableAtoms } from "@clavia/tardigrade-agent/atoms/durable"
import { bunThreadPath } from "../../../src/bun/observe"
import { contentServices } from "../model-services"
import type { ContentFixture } from "../../properties/content/hydration"

export async function bunContentFixture(): Promise<ContentFixture & { readonly seed: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-"))
  const objects = objectStorageFromFileSystem(join(root, "objects")).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))
  const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objects)))
  let prompt: Prompt.Prompt | undefined
  let calls = 0
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: join(root, "host"), actorContext, initialStateAtoms: agentDurableAtoms, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } },
    services: () => Layer.merge(contentServices(value => { prompt = value; calls++ }), objects),
  }))
  let thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
  const resultSchema = methodResult(Schema.Struct({ text: Schema.String }))
  return {
    put: bytes => Effect.runPromise(storage.put(bytes)),
    message: async (content, id) => {
      await Effect.runPromise(thread.invoke("message", { content: [...content] }, { id }))
      return Schema.decodeSync(resultSchema)(await Effect.runPromise(thread.result("message", id)))
    },
    seed: () => Effect.runPromise(Effect.gen(function* () {
      yield* thread.wait
      const journal = bunJournal({ actor: "events", filename: bunThreadPath(join(root, "host"), thread.coordinate) })
      const checkpoint = yield* journal.readCheckpoint.pipe(Effect.ensuring(journal.close))
      if (!checkpoint) return yield* Effect.fail(new RuntimeError("Expected a completed agent checkpoint"))
      const initialState = Object.fromEntries(decodeCheckpoint(checkpoint.payload).durable.filter(entry => entry.name.startsWith("agent.")).map(entry => [entry.name, Schema.decodeUnknownSync(Schema.Json)(entry.state)]))
      thread = yield* host.allocateRootThread({ instance: "main", name: "seeded", initialState })
    })),
    prompt: () => prompt,
    calls: () => calls,
    close: async () => { try { await Effect.runPromise(host.close) } finally { await rm(root, { recursive: true, force: true }) } },
  }
}
