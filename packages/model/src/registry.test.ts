import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelRegistry, ModelRegistryError, layerHttpModelRegistry } from "./registry"
import { layerMemoryModelCatalogRepository } from "./catalog/repository"
import { httpRegistrySource as source } from "./testing/models"

test("the HTTP registry owns fetch and cache policies behind the service", async () => {
  let calls = 0
  const registry = layerHttpModelRegistry({
    sourceUrl: "https://registry.example/api.json", timeoutMillis: 1000,
    fetch: (async (url, options) => {
      expect(url).toBe("https://registry.example/api.json")
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      calls++
      return calls === 1 ? Response.json(source, { headers: { etag: "fixture-1" } }) : new Response("offline", { status: 503 })
    }) as typeof fetch
  }).pipe(Layer.provide(layerMemoryModelCatalogRepository()))
  await Effect.runPromise(Effect.gen(function*() {
    const service = yield* ModelRegistry
    expect((yield* service.load({ policy: "refresh" })).revision).toBe("fixture-1")
    expect((yield* service.load({ policy: "cache-first" })).status).toBe("cached")
    expect(calls).toBe(1)
    expect((yield* service.load({ policy: "refresh" })).status).toBe("cached")
    expect(calls).toBe(2)
    expect((yield* service.load({ policy: "cache-first", scope: { providers: [], policy: { allow: "*" } } })).providers).toEqual([])
  }).pipe(Effect.provide(registry)))
})

test("the HTTP registry fails with a typed error when no snapshot is available", async () => {
  const registry = layerHttpModelRegistry({
    sourceUrl: "https://registry.example/api.json", timeoutMillis: 1000,
    fetch: (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch
  }).pipe(Layer.provide(layerMemoryModelCatalogRepository()))
  const error = await Effect.runPromise(Effect.gen(function*() {
    return yield* (yield* ModelRegistry).load({ policy: "refresh" })
  }).pipe(Effect.provide(registry), Effect.flip))
  expect(error).toBeInstanceOf(ModelRegistryError)
  expect(error.message).toContain("503")
})
