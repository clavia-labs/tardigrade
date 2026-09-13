import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelRegistry, ModelRegistryError } from "./registry"
import { resolveModelLock } from "./resolution"
import { modelCatalogForConfig } from "./lock"
import { modelConfigOf, type ModelConfig } from "./config"
import { customModelConfig as config, registryCatalog as catalog } from "./testing/models"

test("complete custom definitions resolve without a registry or invoking a supplied service", async () => {
  const lock = await Effect.runPromise(resolveModelLock(config))
  const refused = Layer.succeed(ModelRegistry)({ load: () => Effect.die("registry must not be called") })
  expect(await Effect.runPromise(resolveModelLock(config).pipe(Effect.provide(refused)))).toEqual(lock)
  expect(await modelCatalogForConfig(config, lock)).toEqual(lock.catalog)
})

test("an injected registry fills default and explicitly allowed definitions beside custom entries", async () => {
  let calls = 0
  const registry = Layer.succeed(ModelRegistry)({ load: ({ policy }) => Effect.sync(() => {
    expect(policy).toBe("refresh")
    calls++
    return catalog
  }) })
  for (const model_id of ["registered", "custom"]) {
    const mixed: ModelConfig = {
      ...config, default: { provider: "local", model_id },
      allow: [{ provider: "local", model_ids: ["registered", "custom", "allowed"] }]
    }
    const lock = await Effect.runPromise(resolveModelLock(mixed).pipe(Effect.provide(registry)))
    expect(lock.catalog.source).toBe("mixed")
    expect(lock.catalog.providers[0]?.models.map((model) => model.id).sort()).toEqual(["allowed", "custom", "registered"])
    expect(await modelCatalogForConfig(modelConfigOf(mixed), lock)).toEqual(lock.catalog)
  }
  expect(calls).toBe(2)
})

test("missing registry requirements and service failures stay in the typed error channel", async () => {
  const incomplete: ModelConfig = { ...config, default: { provider: "local", model_id: "registered" } }
  const missing = await Effect.runPromise(resolveModelLock(incomplete).pipe(Effect.flip))
  expect(missing).toBeInstanceOf(ModelRegistryError)
  expect(missing.message).toContain("provide a ModelRegistry")
  const failure = new ModelRegistryError({ message: "fixture unavailable" })
  const registry = Layer.succeed(ModelRegistry)({ load: () => Effect.fail(failure) })
  expect(await Effect.runPromise(resolveModelLock(incomplete).pipe(Effect.provide(registry), Effect.flip))).toBe(failure)
})

test("custom metadata overrides supplied definitions before lock validation", async () => {
  const partial: ModelConfig = {
    ...config, default: { provider: "local", model_id: "registered" },
    providers: { local: { ...config.providers.local!, protocol: "openai-chat-completions", models: {
      registered: { metadata: { maxOutputTokens: 1024 } }
    } } }
  }
  const registry = Layer.succeed(ModelRegistry)({ load: () => Effect.succeed(catalog) })
  const lock = await Effect.runPromise(resolveModelLock(partial).pipe(Effect.provide(registry)))
  expect(lock.catalog.providers[0]?.models[0]?.metadata).toEqual({ contextWindowTokens: 128000, maxOutputTokens: 1024 })
})
