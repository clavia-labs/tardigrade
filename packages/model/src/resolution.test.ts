import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelRegistry, ModelRegistryError } from "./registry"
import { resolveModelLock } from "./resolution"
import { modelCatalogForConfig } from "./lock"
import { type ModelConfig } from "./config"
import { customModelConfig as config, registryCatalog as catalog } from "./testing/models"

test("complete custom definitions resolve without a registry or invoking a supplied service", async () => {
  const lock = await Effect.runPromise(resolveModelLock(config))
  const refused = Layer.succeed(ModelRegistry)({ load: () => Effect.die("registry must not be called") })
  expect(await Effect.runPromise(resolveModelLock(config).pipe(Effect.provide(refused)))).toEqual(lock)
  expect((await modelCatalogForConfig(config, lock)).providers[0]?.models[0]?.id).toBe("custom")
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
    expect(lock.models.map((model) => model.model_id).sort()).toEqual(["allowed", "custom", "registered"])
    expect((await modelCatalogForConfig(mixed, lock)).providers[0]?.models).toHaveLength(3)
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
  expect(lock.models[0]).toMatchObject({ contextWindowTokens: 128000, maxOutputTokens: 1024 })
})

test("setup preserves existing definitions without consulting their sources", async () => {
  const previous = await Effect.runPromise(resolveModelLock(config))
  const registry = Layer.succeed(ModelRegistry)({ load: () => Effect.die("unexpected registry lookup") })
  expect(await Effect.runPromise(resolveModelLock(config, { previous }).pipe(Effect.provide(registry)))).toEqual(previous)
})

test("refresh uses each saved source and preserves manual definitions, connections, and options", async () => {
  const manual = await Effect.runPromise(resolveModelLock(config))
  const previous = { ...manual, models: [...manual.models,
    { provider: "local", model_id: "registered", contextWindowTokens: 100, toolCall: true, source: "https://one.example/api.json", options: { temperature: 0.25 } },
    { provider: "local", model_id: "allowed", contextWindowTokens: 200, source: "https://two.example/api.json" }
  ] }
  const calls: Array<string | undefined> = []
  const registry = Layer.succeed(ModelRegistry)({ load: ({ source }) => Effect.sync(() => { calls.push(source); return catalog }) })
  const lock = await Effect.runPromise(resolveModelLock(config, { previous, refresh: true }).pipe(Effect.provide(registry)))
  expect(calls).toEqual(["https://one.example/api.json", "https://two.example/api.json"])
  expect(lock.providers).toEqual(previous.providers)
  expect(lock.models[0]).toEqual(manual.models[0])
  expect(lock.models[1]).toEqual({ provider: "local", model_id: "registered", contextWindowTokens: 128000, source: "https://one.example/api.json", options: { temperature: 0.25 } })
  expect(lock.models[2]?.contextWindowTokens).toBe(64000)
  expect(previous.models[1]?.contextWindowTokens).toBe(100)
})

test("a missing upstream definition fails refresh without mutating the prior lock", async () => {
  const manual = await Effect.runPromise(resolveModelLock(config))
  const previous = { ...manual, models: [{ ...manual.models[0]!, source: "https://gone.example/api.json" }] }
  const before = structuredClone(previous)
  const registry = Layer.succeed(ModelRegistry)({ load: () => Effect.succeed(catalog) })
  const failure = await Effect.runPromise(resolveModelLock(config, { previous, refresh: true }).pipe(Effect.provide(registry), Effect.flip))
  expect(failure.message).toContain("no complete definition for local/custom")
  expect(previous).toEqual(before)
})
