import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { defineActor } from "tardie/core"
import { createHost, objectStorageFromSqlite } from "tardie/bun"
import { NativeOutputSupport, ObjectStorage, agentMessageMethod, infer, nativeOutput } from "tardie/agent"

const reader = defineActor("reader", { message: agentMessageMethod }, [
  infer([nativeOutput], { models: { default: { provider: "test", model_id: "reader" }, allow: "*" } })
])

test("Bun host replays attachments after reopening both thread and object databases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-objects-"))
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const seen: Array<{ boot: number; files: Uint8Array[]; text: string[] }> = []
  const openStore = () => ManagedRuntime.make(objectStorageFromSqlite({
    filename: join(directory, "objects.sqlite")
  }))
  const openHost = (storage: typeof ObjectStorage.Service, boot: number) => createHost({
    actor: reader,
    storage: join(directory, "threads"),
    layersFor: () => Layer.mergeAll(
      Layer.succeed(ObjectStorage, storage),
      Layer.succeed(NativeOutputSupport, { withTools: true }),
      Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
        generateText: () => Effect.die("Use streaming in this fixture"),
        streamText: ({ prompt }) => {
          const files: Uint8Array[] = []
          const text: string[] = []
          for (const message of prompt.content) {
            if (message.role !== "user") continue
            for (const part of message.content) {
              if (part.type === "text") text.push(part.text)
              if (part.type === "file") {
                if (!(part.data instanceof Uint8Array)) throw new Error("Expected resolved attachment bytes")
                files.push(part.data)
              }
            }
          }
          seen.push({ boot, files, text })
          return Stream.make(
            Response.makePart("text-start", { id: "answer" }),
            Response.makePart("text-delta", { id: "answer", delta: "I read the image" }),
            Response.makePart("text-end", { id: "answer" }),
            Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) })
          )
        }
      }))
    )
  })
  let store = openStore()
  let host: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    const storage = await store.runPromise(ObjectStorage)
    const object = await store.runPromise(storage.put(bytes))
    host = await openHost(storage, 0)
    const thread = await host.allocateRootThread({ instance: "test", name: "main" })
    expect(await thread.message({ content: [
      { type: "text", text: "Read this image" },
      { type: "file", mediaType: "image/png", filename: "chart.png", object }
    ] }, { key: "image" })).toBe("I read the image")
    expect(seen).toEqual([{ boot: 0, files: [bytes], text: ["Read this image"] }])

    await host.close()
    host = undefined
    await store.dispose()
    store = openStore()
    host = await openHost(await store.runPromise(ObjectStorage), 1)
    const restored = await host.allocateRootThread({ instance: "test", name: "main" })
    expect(await restored.message({ text: "retry" }, { key: "image" })).toBe("I read the image")
    expect(seen).toHaveLength(1)
    expect(await restored.message({ text: "What does it show?" }, { key: "follow-up" })).toBe("I read the image")
    expect(seen).toEqual([
      { boot: 0, files: [bytes], text: ["Read this image"] },
      { boot: 1, files: [bytes], text: ["Read this image", "What does it show?"] }
    ])
  } finally {
    await host?.close()
    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
