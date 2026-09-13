import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ModelLock, layerModelLock, layerFileModelLock, modelCatalogForConfig, modelConfigForPolicy, modelLockOf, lockedModelState } from "./lock"
import { runtimeModelConfig as config, runtimeModelLock as lock } from "./testing/models"

test("policy selects from locked definitions without binding a config digest", async () => {
  expect((await modelCatalogForConfig(config, modelLockOf(lock))).providers[0]?.models[0]?.id).toBe("qwen")
  expect((await modelCatalogForConfig({ allow: [] }, lock)).providers).toEqual([])
  expect(modelConfigForPolicy(config, lock).providers.local?.baseUrl).toBe("http://localhost:8080/v1")
})

test("invalid coordinates, metadata, sources and policy references are rejected", async () => {
  expect(() => modelLockOf({ ...lock, models: [...lock.models, ...lock.models] })).toThrow("duplicate model")
  expect(() => modelLockOf({ ...lock, providers: {} })).toThrow("absent provider")
  expect(() => modelLockOf({ ...lock, models: [{ provider: "local", model_id: "qwen" }] })).toThrow()
  expect(() => modelLockOf({ ...lock, models: [{ ...lock.models[0], source: "file:///tmp/models.json" }] })).toThrow("HTTP(S)")
  expect(() => modelLockOf({ ...lock, schema: 1 })).toThrow()
  expect(() => modelLockOf({ ...lock, unexpected: true })).toThrow()
  expect(() => modelConfigForPolicy({ allow: "*", default: { provider: "local", model_id: "missing" } }, lock)).toThrow("absent")
  expect(() => modelConfigForPolicy({ allow: [{ provider: "local", model_ids: ["missing"] }] }, lock)).toThrow("absent")
})

test("an in-memory lock supplies runtime services without a filesystem or registry", async () => {
  const state = await Effect.runPromise(lockedModelState(config).pipe(Effect.provide(layerModelLock(lock))))
  expect(state.model.providers.local?.env).toEqual(["API_KEY"])
  expect(state.catalog.snapshot.providers[0]?.models[0]?.metadata.contextWindowTokens).toBe(32768)
})

test("file and in-memory layers validate and supply the same lock", async () => {
  const fs = Layer.succeed(FileSystem)({ readFileString: (path: string) => {
    expect(path).toBe("models.lock.json")
    return Effect.succeed(JSON.stringify(lock))
  } } as unknown as FileSystem)
  const file = layerFileModelLock("models.lock.json").pipe(Layer.provide(fs))
  expect(await Effect.runPromise(ModelLock.pipe(Effect.provide(file)))).toEqual(await Effect.runPromise(ModelLock.pipe(Effect.provide(layerModelLock(lock)))))
  const invalid = await Effect.runPromise(ModelLock.pipe(Effect.provide(layerModelLock({ schema: 2 })), Effect.flip))
  expect(invalid._tag).toBe("ModelLockError")
})
