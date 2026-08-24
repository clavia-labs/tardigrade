import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

import { modelCatalogOf } from "./catalog"
import { layerFileModelCatalogRepository, ModelCatalogRepository } from "./catalog-repository"

let root = ""

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const snapshot = modelCatalogOf({
  openai: {
    id: "openai",
    models: { gpt: { id: "gpt", limit: { context: 128_000 } } }
  }
}, "catalog-1", 1)

describe("file model catalog repository", () => {
  test("writes atomically and reads only the matching source", async () => {
    root = await mkdtemp(join(tmpdir(), "tardigrade-catalog-repository-"))
    const path = join(root, ".tardigrade", "models.json")
    const repository = layerFileModelCatalogRepository(path).pipe(Layer.provide(BunFileSystem.layer))
    const found = await Effect.runPromise(Effect.gen(function*() {
      const store = yield* ModelCatalogRepository
      yield* store.write("https://models.dev/api.json", snapshot)
      return {
        matching: yield* store.read("https://models.dev/api.json"),
        other: yield* store.read("https://catalog.example/models.json")
      }
    }).pipe(Effect.provide(repository)))

    expect(found.matching).toMatchObject({ revision: "catalog-1", status: "cached" })
    expect(found.other).toBeUndefined()
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schema: 1,
      snapshot: { revision: "catalog-1", status: "fresh" }
    })
  })
})
