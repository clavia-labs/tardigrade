import { ModelSelection } from "./settings"
import { Effect, Layer } from "effect"
import { ModelLock, modelLockOf, modelLockService } from "./lock"
import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { modelConfigOf } from "./config"
import { selectedModelFrom, modelLayerWith, type SelectedModel } from "./selection"
import type { ModelCatalogState } from "./catalog/index"

const config = (settings = {}) => modelConfigOf({ default: { provider: "test", model_id: "model" }, allow: "*", providers: { test: { baseUrl: "https://fixture.invalid", protocol: "openai-responses", env: ["KEY"], models: { model: settings } } } })
const catalog = (contextWindowTokens?: number): ModelCatalogState => ({ snapshot: { source: "models.dev", revision: "r", refreshedAt: 1, status: "fresh", providers: [{ id: "test", name: "Test", env: [], models: [{ id: "model", metadata: contextWindowTokens === undefined ? {} : { contextWindowTokens } }] }] } })

test("context capacity comes from catalog metadata and cannot be configured as a request setting", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), capacity => {
    expect(selectedModelFrom(config(), { KEY: "secret" }, catalog(capacity)).contextWindowTokens).toBe(capacity)
    expect(() => config({ contextWindowTokens: capacity })).toThrow("unsupported settings")
  }))
})

test.each([undefined, 0, -1, 0.5, Infinity, NaN])("missing or invalid catalog capacity fails (%s)", capacity => {
  expect(() => selectedModelFrom(config(), { KEY: "secret" }, catalog(capacity))).toThrow(
    capacity === undefined ? "no context window" : "positive safe integer"
  )
})

test("configuration retains ordered fallbacks and rejects missing providers", () => {
  const source = config()
  const fallback = [{ provider: "test", model_id: "backup" }]
  expect(modelConfigOf({ ...source, fallback }).fallback).toEqual(fallback)
  expect(() => modelConfigOf({ ...source, fallback: [{ provider: "absent", model_id: "backup" }] })).toThrow("unconfigured provider")
  expect(() => modelConfigOf({ ...source, fallback: {} })).toThrow("fallback must be an array")
})

const binding = () => modelLayerWith({}, () => { throw new Error("provider execution was not requested") })

test("model binding requires a supplied lock before initialization", async () => {
  const build = Effect.scoped(Layer.build(binding()))
  // ModelLock is deliberately absent to check the runtime boundary as well as its type.
  // @ts-expect-error ModelLock must be supplied by the host.
  // @effect-diagnostics-next-line missingEffectContext:off
  await expect(Effect.runPromise(build)).rejects.toThrow("tardigrade/model/ModelLock")
})

test("model binding forwards supplied definitions and lookup without reconstruction", async () => {
  const definitions = modelLockOf({ schema: 2,
    providers: { custom: { protocol: "openai-chat-completions", baseUrl: "https://custom.test", env: ["KEY"] } },
    models: [{ provider: "custom", model_id: "small", contextWindowTokens: 32000, options: { temperature: 0.2 }, source: "https://fixture.test/catalog" }]
  })
  const supplied = modelLockService(definitions, { allow: "*", default: { provider: "custom", model_id: "small" } })
  const resolved = await Effect.runPromise(ModelLock.pipe(Effect.provide(binding().pipe(
    Layer.provide(Layer.succeed(ModelLock, supplied))
  ))))
  expect(resolved).toBe(supplied)
  expect(resolved.definitions).toEqual(definitions)
  expect(resolved.resolve().contextWindowTokens).toBe(32000)
})

test("provider selection gets connections, metadata and options exclusively from the supplied lock", async () => {
  const definitions = modelLockOf({ schema: 2,
    providers: { custom: { protocol: "openai-chat-completions", baseUrl: "https://locked.test", env: ["KEY"] } },
    models: [{ provider: "custom", model_id: "small", contextWindowTokens: 32000, maxOutputTokens: 2048,
      pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 }, options: { temperature: 0.2 } }]
  })
  const supplied = modelLockService(definitions, { allow: "*", default: { provider: "custom", model_id: "small" } })
  let selected: SelectedModel | undefined
  const layer = modelLayerWith({ KEY: "fixture" }, value => {
    selected = value
    throw new Error("selection observed")
  }).pipe(Layer.provide(Layer.succeed(ModelLock, supplied)))
  await expect(Effect.runPromise(Effect.flatMap(ModelSelection, selection => selection.settings!()).pipe(Effect.provide(layer))))
    .rejects.toThrow("selection observed")
  expect(selected).toMatchObject({ ...definitions.models[0], baseUrl: "https://locked.test", protocol: "openai-chat-completions", apiKey: "fixture" })
})
