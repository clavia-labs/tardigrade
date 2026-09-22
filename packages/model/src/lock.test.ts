import { modelCredentialsFrom } from "./config"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelLock, lockedModelConfigOf, layerModelLock, modelLockOf, modelLockService } from "./lock"

const definitions = {
  schema: 2,
  providers: { fixture: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: ["FIXTURE_KEY"] } },
  models: [{ provider: "fixture", model_id: "small", contextWindowTokens: 1000 }, { provider: "fixture", model_id: "large", contextWindowTokens: 8000 }]
}

test("a supplied lock resolves metadata and policy without registry access", async () => {
  const policy = { default: { provider: "fixture", model_id: "small" }, allow: "*" } as const
  const lock = await Effect.runPromise(ModelLock.pipe(Effect.provide(layerModelLock(definitions, policy))))
  expect(lock.resolve()).toEqual({ model: policy.default, contextWindowTokens: 1000, models: policy })
  expect(lock.resolve({ provider: "fixture", model_id: "large" }).contextWindowTokens).toBe(8000)
  expect(() => lock.resolve({ provider: "fixture", model_id: "absent" })).toThrow("absent from models.lock.json")
})

test("locked selection enforces host authority", () => {
  const lock = modelLockService(modelLockOf(definitions), { allow: [{ provider: "fixture", model_ids: ["small"] }] })
  expect(() => lock.resolve({ provider: "fixture", model_id: "large" })).toThrow("excluded by the host model policy")
  expect(() => lock.resolve()).toThrow("no model was selected")
})

test("lock validation refuses missing context windows and duplicate coordinates", () => {
  expect(() => modelLockOf({ ...definitions, models: [{ provider: "fixture", model_id: "small" }] })).toThrow("contextWindowTokens")
  expect(() => modelLockOf({ ...definitions, models: [definitions.models[0], definitions.models[0]] })).toThrow("duplicate")
})

test("lock lookup is isolated from later changes to its source definitions and policy", () => {
  const source = modelLockOf(definitions)
  const policy = { default: { provider: "fixture", model_id: "small" }, allow: "*" } as const
  const lock = modelLockService(source, policy)
  Object.assign(source.models[0]!, { contextWindowTokens: 1 })
  Object.assign(policy.default, { model_id: "large" })
  expect(lock.resolve()).toMatchObject({ model: { model_id: "small" }, contextWindowTokens: 1000 })
})

test("host resolution uses locked connections and only declared credentials", () => {
  const lock = modelLockOf(definitions)
  const policy = { default: { provider: "fixture", model_id: "small" }, allow: "*" }
  const model = lockedModelConfigOf(policy, lock)
  expect(lockedModelConfigOf({ ...policy, providers: { fixture: { baseUrl: "https://stale.invalid" } } }, lock)).toEqual(model)
  expect(model.providers.fixture?.baseUrl).toBe("https://fixture.invalid")
  expect(modelCredentialsFrom(model, { FIXTURE_KEY: " secret ", OTHER_KEY: "unrelated" })).toEqual({ FIXTURE_KEY: "secret" })
  expect(modelCredentialsFrom(model, { FIXTURE_KEY: " " })).toEqual({})
  expect(lockedModelConfigOf(undefined, lock).providers).toEqual(model.providers)
  expect(() => lockedModelConfigOf("invalid", lock)).toThrow("models must be a JSON object")
  expect(() => lockedModelConfigOf({ ...policy, default: { provider: "fixture", model_id: "absent" } }, lock)).toThrow("absent from models.lock.json")
})
