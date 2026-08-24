import type { ModelCoordinate } from "tardie"
import type { OutputCapability } from "./output"
import type { ModelMetadata, MetadataValue } from "./metadata"

export type { ModelCoordinate } from "tardie"

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

export const MODEL_PROVIDER_KINDS = [
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
  "amazon-bedrock",
  "microsoft-foundry",
  "google-ai",
  "google-vertex-ai",
  "openai",
  "anthropic",
  "openrouter",
  "openai-compatible"
] as const

export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number]

// ModelProvider describes how one configured provider speaks. Credentials remain in the host configuration.
export interface ModelProvider {
  readonly kind: ModelProviderKind
  readonly driver: ModelDriver
  readonly baseUrl?: string
  readonly credentialLabel: string
}

export interface ModelProviderOptions {
  readonly baseUrl?: string
  readonly driver?: ModelDriver
}

const provider = (
  kind: ModelProviderKind,
  driver: ModelDriver,
  credentialLabel: string,
  options: ModelProviderOptions = {},
  defaults: { readonly baseUrl?: string } = {}
): ModelProvider => ({
  kind,
  driver: options.driver ?? driver,
  ...((options.baseUrl ?? defaults.baseUrl) === undefined ? {} : { baseUrl: options.baseUrl ?? defaults.baseUrl }),
  credentialLabel
})

export const vercelAIGateway = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("vercel-ai-gateway", "openai-responses", "Vercel AI Gateway API key", options, {
    baseUrl: "https://ai-gateway.vercel.sh/v1"
  })

export const cloudflareAIGateway = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("cloudflare-ai-gateway", "openai-responses", "Cloudflare API token", options)

export const amazonBedrock = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("amazon-bedrock", "bedrock-converse", "AWS or AI Gateway credential", options)

export const microsoftFoundry = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("microsoft-foundry", "openai-responses", "Microsoft Foundry API key", options)

export const googleAI = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("google-ai", "openai-chat-completions", "Gemini API key", options, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  })

export const googleVertexAI = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("google-vertex-ai", "openai-chat-completions", "Google access token", options)

export const openAI = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("openai", "openai-responses", "OpenAI API key", options, {
    baseUrl: "https://api.openai.com/v1"
  })

export const anthropic = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("anthropic", "anthropic-messages", "Anthropic API key", options, {
    baseUrl: "https://api.anthropic.com"
  })

export const openRouter = (options: ModelProviderOptions = {}): ModelProvider =>
  provider("openrouter", "openai-chat-completions", "OpenRouter API key", options, {
    baseUrl: "https://openrouter.ai/api/v1"
  })

export const openAICompatible = (
  options: ModelProviderOptions & { readonly baseUrl: string }
): ModelProvider => provider("openai-compatible", "openai-chat-completions", "API key", options)

export interface DirectoryProvider {
  readonly route: ModelProvider
  readonly models: Readonly<Record<string, ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }>>
}

export interface ModelDirectoryConfig {
  readonly revision: string
  readonly providers: Readonly<Record<string, DirectoryProvider>>
}

export interface ResolvedModel {
  readonly provider: string
  readonly model_id: string
  readonly route: ModelProvider
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("tardie/usage").ModelPricing
  readonly output?: OutputCapability
  readonly metadata: ModelMetadata & { readonly contextWindowTokens: MetadataValue<number> }
  readonly catalogRevision: string
}

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`)
  return value
}

// modelDirectory resolves exact actor coordinates against configured providers and their metadata.
export const modelDirectory = (config: ModelDirectoryConfig) => {
  if (config.revision.trim().length === 0) throw new Error("model directory revision cannot be empty")
  for (const [providerName, definition] of Object.entries(config.providers)) {
    if (providerName.trim().length === 0) throw new Error("model provider name cannot be empty")
    for (const [modelId, metadata] of Object.entries(definition.models)) {
      if (modelId.trim().length === 0) throw new Error(`provider ${JSON.stringify(providerName)} has an empty model id`)
      positiveInteger(metadata.contextWindowTokens.value, `${providerName}/${modelId} contextWindowTokens`)
      if (metadata.maxOutputTokens !== undefined) {
        positiveInteger(metadata.maxOutputTokens.value, `${providerName}/${modelId} maxOutputTokens`)
      }
    }
  }
  return {
    revision: config.revision,
    providers: (): ReadonlyArray<string> => Object.keys(config.providers).sort(),
    resolve: (coordinate: ModelCoordinate): ResolvedModel => {
      const found = config.providers[coordinate.provider]
      if (found === undefined) {
        const available = Object.keys(config.providers).sort()
        throw new Error(
          `provider ${JSON.stringify(coordinate.provider)} is not configured for model ${JSON.stringify(coordinate.model_id)}; ` +
          `run \`tdg setup\`${available.length === 0 ? "" : `; configured providers: ${available.join(", ")}`}`
        )
      }
      const metadata = found.models[coordinate.model_id]
      if (metadata === undefined) {
        throw new Error(
          `model metadata is missing for ${coordinate.provider}/${coordinate.model_id}; run \`tdg setup\` to add that model`
        )
      }
      return {
        ...coordinate,
        route: found.route,
        contextWindowTokens: metadata.contextWindowTokens.value,
        ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens.value }),
        ...(metadata.pricing === undefined ? {} : { pricing: metadata.pricing.value }),
        ...(metadata.output === undefined ? {} : { output: metadata.output.value }),
        metadata,
        catalogRevision: config.revision
      }
    }
  }
}
