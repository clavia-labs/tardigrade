import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ModelLock, layerModelLock, layerFileModelLock, modelCatalogForConfig, modelConfigForPolicy, modelLockOf, parseModelLock, lockedModelState } from "./lock"
import { runtimeModelConfig as config, runtimeModelLock as lock } from "./testing/models"

test("policy selects from locked definitions without binding a config digest", async () => {
  expect((await modelCatalogForConfig(config, modelLockOf(lock))).providers[0]?.models[0]?.id).toBe("qwen")
  expect((await modelCatalogForConfig({ allow: [] }, lock)).providers).toEqual([])
  expect(modelConfigForPolicy(config, lock).providers.local?.baseUrl).toBe("http://localhost:8080/v1")
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

})


test.each([
  { name: "missing context", value: { ...lock, models: [{ provider: "local", model_id: "qwen" }] }, detail: '["models"][0]["contextWindowTokens"] (model local/qwen): Missing key' },
  { name: "negative context", value: { ...lock, models: [{ ...lock.models[0], contextWindowTokens: -1 }] }, detail: '["models"][0]["contextWindowTokens"] (model local/qwen): Expected a value greater than 0' },
  { name: "unknown field", value: { ...lock, models: [{ ...lock.models[0], typo: true }] }, detail: '["models"][0]["typo"] (model local/qwen): Expected no excess property' },
  { name: "invalid options", value: { ...lock, models: [{ ...lock.models[0], options: [] }] }, detail: '["models"][0]["options"] (model local/qwen): Expected object' },
  { name: "duplicate coordinate", value: { ...lock, models: [...lock.models, ...lock.models] }, detail: 'models[1]: duplicate model local/qwen; first declared at models[0]' },
  { name: "missing provider", value: { ...lock, providers: {} }, detail: 'models[0].provider (model local/qwen) references an absent provider; add providers["local"]' },
  { name: "invalid credential name", value: { ...lock, providers: { local: { ...lock.providers.local, env: ["BAD-NAME"] } } }, detail: 'providers["local"]: provider "local" env contains invalid name "BAD-NAME"' },
  { name: "future schema", value: { ...lock, schema: 3 }, detail: 'unsupported schema 3; this runtime supports schema 2' }
])("lock diagnostics: $name", async ({ value, detail }) => {
  const error = await Effect.runPromise(ModelLock.pipe(Effect.provide(layerModelLock(value)), Effect.flip))
  expect(error).toMatchObject({ _tag: "ModelLockError", message: `models.lock.json is invalid: ${detail}` })
})

test("URL errors name the provider or model field without echoing input", () => {
  for (const url of ["oops", "file:///tmp/models.json", "/relative", "https://user:secret@", ""]) {
    const endpoint = { ...lock, providers: { local: { ...lock.providers.local, baseUrl: url } } }
    const source = { ...lock, models: [{ ...lock.models[0], source: url }] }
    for (const [value, field] of [[endpoint, 'providers'], [source, 'source']] as const) {
      try { modelLockOf(value); throw new Error("expected rejection") } catch (error) {
        expect(error).toHaveProperty("_tag", "ModelLockError")
        expect((error as Error).message).toContain(field)
        expect((error as Error).message).not.toContain("secret")
        if (url !== "") expect((error as Error).message).toContain("absolute HTTP(S) URL")
      }
    }
  }
  expect(() => modelLockOf({ ...lock, models: [{ ...lock.models[0], source: "oops" }] })).toThrow("models[0].source (model local/qwen)")
  expect(() => modelLockOf({ ...lock, providers: { local: { ...lock.providers.local, baseUrl: "oops" } } })).toThrow('providers["local"].baseUrl')
  for (const baseUrl of ["http://localhost:8080/v1", "https://gateway.example/v1"]) {
    expect(modelLockOf({ ...lock, providers: { local: { ...lock.providers.local, baseUrl } } }).providers.local?.baseUrl).toBe(baseUrl)
  }
})

test("schema migration and JSON errors include actionable context", () => {
  expect(() => modelLockOf({ schema: 1 }, "deployment/models.lock.json")).toThrow("deployment/models.lock.json is invalid: schema 1 is unsupported. Run `tdg setup` to migrate saved definitions offline, or `tdg models lock` to migrate and refresh")
  expect(() => parseModelLock("{", "deployment/models.lock.json")).toThrow("deployment/models.lock.json is invalid JSON:")
  expect(() => parseModelLock('{"schema":2}', "deployment/models.lock.json")).toThrow('deployment/models.lock.json is invalid: ["providers"]: Missing key')
  expect(() => modelConfigForPolicy({ allow: "*", default: { provider: "local", model_id: "missing" } }, lock)).toThrow("models.default: model local/missing is absent")
  expect(() => modelConfigForPolicy({ allow: [{ provider: "local", model_ids: ["missing"] }] }, lock)).toThrow("models.allow[0].model_ids[0]: model local/missing is absent")
})
