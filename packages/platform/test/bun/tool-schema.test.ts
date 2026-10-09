import { expect, test } from "bun:test"
import { Effect, JsonSchema, Layer, Redacted, Schema, SchemaRepresentation } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { closeObjectSchemas, DEFAULT_SCHEMA_IMPORT_OPTIONS } from "@clavia/tardigrade-agent/services/model"
import { providerLayer, type ProviderOptions } from "@clavia/tardigrade-model/providers/layer"

// inputSchema declares open objects, the JSON Schema default for a tool that omits additionalProperties.
const inputSchema = { type: "object", properties: { path: { type: "string" }, filter: { type: "object", properties: { key: { type: "string" } } } }, required: ["path"] }
const client = { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }
const providers: readonly [ProviderOptions, (body: { readonly tools: readonly Record<string, unknown>[] }) => unknown][] = [
  [{ provider: "openai", client, model: { model: "gpt-5" } }, body => body.tools[0]!["parameters"]],
  [{ provider: "anthropic", client, model: { model: "claude" } }, body => body.tools[0]!["input_schema"]],
  [{ provider: "openrouter", client, model: { model: "vendor/model" } }, body => (body.tools[0]!["function"] as { readonly parameters: unknown }).parameters],
]

const sent = (options: ProviderOptions, read: (body: { readonly tools: readonly Record<string, unknown>[] }) => unknown) => {
  const parameters = Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(inputSchema), DEFAULT_SCHEMA_IMPORT_OPTIONS))
  let schema: unknown
  const fetch = Object.assign(async (_: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    schema = read(JSON.parse(String(init?.body)))
    return Response.json({})
  }, { preconnect: globalThis.fetch.preconnect })
  return Effect.runPromise(LanguageModel.generateText({ prompt: "read", toolkit: Toolkit.make(Tool.dynamic("read", { parameters })), disableToolCallResolution: true }).pipe(
    Effect.provide(providerLayer(options).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.ignore,
    Effect.map(() => schema),
  ))
}

test("open tool schemas reach each provider as plain objects", async () => {
  const [openai, anthropic, openrouter] = await Promise.all(providers.map(([options, read]) => sent(options, read)))
  expect(openai).toMatchObject({ type: "object", additionalProperties: false, properties: { filter: { anyOf: [{ type: "object", additionalProperties: false }, { type: "null" }] } } })
  expect(anthropic).toMatchObject({ type: "object", additionalProperties: false, properties: { filter: { anyOf: [{ type: "object", additionalProperties: false }, { type: "null" }] } } })
  expect(openrouter).toMatchObject({ type: "object", properties: { filter: { type: "object" } } })
  for (const schema of [openai, anthropic, openrouter]) expect(JSON.stringify(schema)).not.toContain("allOf")
  expect(closeObjectSchemas({ type: "object" })).toEqual({ type: "object" })
})
