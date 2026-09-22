import { ModelSelection } from "./settings"
import { Effect, Layer } from "effect"
import { ModelLock, modelLockOf, modelLockService } from "./lock"
import { expect, test } from "bun:test"
import { modelConfigOf } from "./config"
import { modelLayerWith, type SelectedModel } from "./selection"

const config = (settings = {}) => modelConfigOf({ default: { provider: "test", model_id: "model" }, allow: "*", providers: { test: { baseUrl: "https://fixture.invalid", protocol: "openai-responses", env: ["KEY"], models: { model: settings } } } })
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
