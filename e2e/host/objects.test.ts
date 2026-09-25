import { testModelLockLayer } from "@clavia/tardigrade-agent/testing/model"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { defineActor } from "tardie/core"
import { createHost, objectStorageFromSqlite } from "tardie/bun"
import { NativeOutputSupport, ObjectStorage, agentMessageMethod, cachedObjectStorage, infer, makeObjectStorage, nativeOutput, sqlObjectCache, type ObjectRef } from "tardie/agent"

const objectKeyOf = (object: ObjectRef) => `${object.algorithm}:${object.digest}`

const reader = defineActor("reader", { message: agentMessageMethod }, [
  infer([nativeOutput], { models: { default: { provider: "test", model_id: "reader" }, allow: "*" } })
])

test.each(["sqlite", "cached-files"] as const)("Bun host replays attachments after reopening thread and object storage: %s", async (backend) => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-objects-"))
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const seen: Array<{ boot: number; files: Uint8Array[]; text: string[] }> = []
  const files = join(directory, "objects")
  await mkdir(files)
  const reads: string[] = []
  const backing = makeObjectStorage({
    read: (key) => Effect.tryPromise(async () => {
      reads.push(key)
      try {
        return new Uint8Array(await readFile(join(files, key)))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    }),
    write: (key, value) => Effect.tryPromise(() => writeFile(join(files, key), value))
  })
  const openStore = () => ManagedRuntime.make(backend === "sqlite"
    ? objectStorageFromSqlite({ filename: join(directory, "objects.sqlite") }, { maxObjectBytes: 8 })
    : Layer.effect(ObjectStorage, sqlObjectCache({
      namespace: files, capabilities: { maxObjectBytes: 1024 }, maxCachedObjectBytes: 8, maxCacheBytes: 16
    }).pipe(Effect.map(cache => cachedObjectStorage(backing, cache)))).pipe(
      Layer.provide(SqliteClient.layer({ filename: join(directory, "cache.sqlite") }))
    ))
  const openHost = (storage: typeof ObjectStorage.Service, boot: number) => createHost({
    actor: reader,
    storage: join(directory, "threads"),
    layersFor: () => Layer.mergeAll(testModelLockLayer,
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
    if (backend === "sqlite") {
      expect(await store.runPromise(storage.put(new Uint8Array(9)).pipe(Effect.flip))).toMatchObject({ reason: "TooLarge", actualBytes: 9, maxObjectBytes: 8 })
      for (let i = 0; i < 8; i++) await store.runPromise(storage.put(new Uint8Array(8).fill(i)))
    }
    if (backend === "cached-files") expect(new Uint8Array(await readFile(join(files, objectKeyOf(object))))).toEqual(bytes)
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
    if (backend === "cached-files") {
      expect(reads).toEqual([])
      const reopened = await store.runPromise(ObjectStorage)
      await store.runPromise(reopened.put(new Uint8Array(8).fill(1)))
      await store.runPromise(reopened.put(new Uint8Array(8).fill(2)))
      expect(await restored.message({ text: "Read it after eviction" }, { key: "evicted" })).toBe("I read the image")
      expect(seen.at(-1)?.files).toEqual([bytes])
      expect(reads).toEqual([objectKeyOf(object)])
      expect(await restored.message({ text: "Read it from the warm cache" }, { key: "warm" })).toBe("I read the image")
      expect(reads).toEqual([objectKeyOf(object)])

      const largeBytes = new Uint8Array(9).fill(3)
      const large = await store.runPromise(reopened.put(largeBytes))
      expect(new Uint8Array(await readFile(join(files, objectKeyOf(large))))).toEqual(largeBytes)
      const largeThread = await host.allocateRootThread({ instance: "test", name: "oversized" })
      expect(await largeThread.message({ content: [{ type: "file", mediaType: "image/png", object: large }] }, { key: "large" })).toBe("I read the image")
      expect(seen.at(-1)?.files).toEqual([largeBytes])
      expect(await largeThread.message({ text: "Read it again" }, { key: "large-again" })).toBe("I read the image")
      expect(seen.at(-1)?.files).toEqual([largeBytes])
      expect(reads).toEqual([objectKeyOf(object), objectKeyOf(large), objectKeyOf(large)])
    }
  } finally {
    await host?.close()
    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
