import { expect, test } from "bun:test"
import { modelConfigOf } from "../config"
import { modelCatalogWithConfiguredModels } from "./index"

const config = (metadata: unknown) => modelConfigOf({
  allow: "*",
  default: { provider: "localhost", model_id: "local" },
  providers: { localhost: {
    protocol: "openai-chat-completions", baseUrl: "http://localhost:8080/v1", env: ["API_KEY"],
    models: { local: { metadata } }
  } }
})

test("complete custom metadata supplies an offline catalog", async () => {
  const snapshot = await modelCatalogWithConfiguredModels(config({ contextWindowTokens: 32768, toolCall: true }))
  expect(snapshot).toMatchObject({ source: "custom", providers: [{ id: "localhost", models: [{
    id: "local", metadata: { contextWindowTokens: 32768, toolCall: true }
  }] }] })
  expect((await modelCatalogWithConfiguredModels(config({ contextWindowTokens: 65536 })))?.revision).not.toBe(snapshot?.revision)
})

test("partial metadata uses registry capacity without mutating the snapshot", async () => {
  const snapshot = {
    source: "models.dev" as const, revision: "registry", refreshedAt: 1, status: "fresh" as const,
    providers: [{ id: "localhost", name: "Local", env: ["API_KEY"], models: [
      { id: "local", metadata: { contextWindowTokens: 32768, toolCall: false } },
      { id: "other", metadata: { contextWindowTokens: 8192 } }
    ] }]
  }
  const merged = await modelCatalogWithConfiguredModels(config({ toolCall: true }), snapshot)
  expect(merged).toMatchObject({ source: "mixed", providers: [{ models: [
    { id: "local", metadata: { contextWindowTokens: 32768, toolCall: true } }, { id: "other" }
  ] }] })
  expect(snapshot.providers[0]?.models[0]?.metadata.toolCall).toBe(false)
  expect(await modelCatalogWithConfiguredModels(config({ toolCall: true }))).toBeUndefined()
})

test.each([{ contextWindowTokens: 0 }, { contextWindowTokens: -1 }, { toolCall: "yes" }, { typo: true }])("rejects invalid custom metadata %j", (metadata) => {
  expect(() => config(metadata)).toThrow()
})
