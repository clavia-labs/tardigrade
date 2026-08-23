import type { OutputCapability } from "./output"
import type { ModelMetadata, MetadataValue } from "./metadata"
import type { ModelReference } from "tardie"

export type { ModelReference } from "tardie"

export const MODEL_DRIVERS = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "bedrock-converse"
] as const

export type ModelDriver = (typeof MODEL_DRIVERS)[number]

export const modelDriverOf = (value: string): ModelDriver => {
  if ((MODEL_DRIVERS as ReadonlyArray<string>).includes(value)) return value as ModelDriver
  throw new Error(`model driver must be one of ${MODEL_DRIVERS.join(", ")}, got ${JSON.stringify(value)}`)
}

export const MODEL_CONNECTION_KINDS = [
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
  "amazon-bedrock",
  "azure-ai",
  "google-vertex-ai",
  "openai",
  "anthropic",
  "openrouter",
  "openai-compatible"
] as const

export type ModelConnectionKind = (typeof MODEL_CONNECTION_KINDS)[number]

export interface ModelConnection {
  readonly kind: ModelConnectionKind
  readonly driver: ModelDriver
  readonly baseUrl?: string
  readonly provider?: string
  readonly modelListUrl?: string
  readonly credential: string
}

export interface ModelConnectionOptions {
  readonly baseUrl?: string
  readonly driver?: ModelDriver
}

const connection = (
  kind: ModelConnectionKind,
  driver: ModelDriver,
  credential: string,
  options: ModelConnectionOptions = {},
  defaults: { readonly baseUrl?: string; readonly provider?: string; readonly modelListUrl?: string } = {}
): ModelConnection => ({
  kind,
  driver: options.driver ?? driver,
  credential,
  ...((options.baseUrl ?? defaults.baseUrl) === undefined ? {} : { baseUrl: options.baseUrl ?? defaults.baseUrl }),
  ...(defaults.provider === undefined ? {} : { provider: defaults.provider }),
  ...(defaults.modelListUrl === undefined ? {} : { modelListUrl: defaults.modelListUrl })
})

export const vercelAIGateway = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("vercel-ai-gateway", "openai-responses", "Vercel AI Gateway API key", options, {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    provider: "vercel-ai-gateway",
    modelListUrl: "https://ai-gateway.vercel.sh/v1/models"
  })

export const cloudflareAIGateway = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("cloudflare-ai-gateway", "openai-responses", "Cloudflare API token", options, {
    provider: "cloudflare-ai-gateway"
  })

export const amazonBedrock = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("amazon-bedrock", "bedrock-converse", "AWS or AI Gateway credential", options, { provider: "bedrock" })

export const azureAI = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("azure-ai", "openai-responses", "Azure AI API key or token", options, { provider: "azure-ai" })

export const googleVertexAI = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("google-vertex-ai", "openai-chat-completions", "Google access token", options, { provider: "google-vertex-ai" })

export const openAI = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("openai", "openai-responses", "OpenAI API key", options, {
    baseUrl: "https://api.openai.com/v1",
    provider: "openai",
    modelListUrl: "https://api.openai.com/v1/models"
  })

export const anthropic = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("anthropic", "anthropic-messages", "Anthropic API key", options, {
    baseUrl: "https://api.anthropic.com",
    provider: "anthropic",
    modelListUrl: "https://api.anthropic.com/v1/models"
  })

export const openRouter = (options: ModelConnectionOptions = {}): ModelConnection =>
  connection("openrouter", "openai-chat-completions", "OpenRouter API key", options, {
    baseUrl: "https://openrouter.ai/api/v1",
    provider: "openrouter",
    modelListUrl: "https://openrouter.ai/api/v1/models"
  })

export const openAICompatible = (
  options: ModelConnectionOptions & { readonly baseUrl: string }
): ModelConnection => connection("openai-compatible", "openai-chat-completions", "API key", options)

export interface ModelDefinition {
  readonly id: string
  readonly connection: string
  readonly metadata: ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }
}

export interface ModelCatalogConfig {
  readonly revision: string
  readonly default?: ModelReference
  readonly connections: Readonly<Record<string, ModelConnection>>
  readonly models: Readonly<Record<string, ModelDefinition>>
}

export interface ResolvedModel {
  readonly name: string
  readonly id: string
  readonly connection: string
  readonly route: ModelConnection
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly output?: OutputCapability
  readonly metadata: ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }
  readonly catalogRevision: string
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`)
  return value
}

export const modelCatalog = (config: ModelCatalogConfig) => {
  if (config.revision.trim().length === 0) throw new Error("model catalog revision cannot be empty")
  for (const [name, definition] of Object.entries(config.models)) {
    if (definition.id.trim().length === 0) throw new Error(`model ${JSON.stringify(name)} has an empty id`)
    if (config.connections[definition.connection] === undefined) {
      throw new Error(`model ${JSON.stringify(name)} names unknown connection ${JSON.stringify(definition.connection)}`)
    }
    positiveInteger(definition.metadata.contextWindowTokens.value, `model ${JSON.stringify(name)} contextWindowTokens`)
    if (definition.metadata.maxOutputTokens !== undefined) {
      positiveInteger(definition.metadata.maxOutputTokens.value, `model ${JSON.stringify(name)} maxOutputTokens`)
    }
  }
  const defaultConnection = (): string | undefined => {
    if (typeof config.default === "object") return config.default.connection
    if (typeof config.default === "string") return config.models[config.default]?.connection
    return undefined
  }
  const resolved = (name: string, definition: ModelDefinition): ResolvedModel => ({
    name,
    id: definition.id,
    connection: definition.connection,
    route: config.connections[definition.connection]!,
    contextWindowTokens: definition.metadata.contextWindowTokens.value,
    ...(definition.metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: definition.metadata.maxOutputTokens.value }),
    ...(definition.metadata.output === undefined ? {} : { output: definition.metadata.output.value }),
    metadata: definition.metadata,
    catalogRevision: config.revision
  })
  return {
    revision: config.revision,
    list: (): ReadonlyArray<string> => Object.keys(config.models).sort(),
    resolve: (reference?: ModelReference): ResolvedModel => {
      const selected = reference ?? config.default
      if (selected === undefined) throw new Error("no default model is configured")
      if (typeof selected === "string") {
        const named = config.models[selected]
        if (named !== undefined) return resolved(selected, named)
      }
      const asked = typeof selected === "string" ? { id: selected } : selected
      const connection = asked.connection ?? defaultConnection()
      if (connection === undefined) {
        throw new Error(`model ${JSON.stringify(asked.id)} requires a connection because no default connection is configured`)
      }
      const route = config.connections[connection]
      if (route === undefined) throw new Error(`unknown model connection ${JSON.stringify(connection)}`)
      const exact = Object.entries(config.models).find(([, model]) => model.id === asked.id && model.connection === connection)
      if (exact === undefined) {
        throw new Error(`model ${JSON.stringify(asked.id)} on connection ${JSON.stringify(connection)} has no declared metadata`)
      }
      const [name, definition] = exact
      return resolved(name, definition)
    }
  }
}
