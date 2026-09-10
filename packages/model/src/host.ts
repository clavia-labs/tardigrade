import { Effect, Layer } from "effect"
import { Infer, intersectModelPolicies, modelAllowedBy, type ModelPolicy, type ModelRef, type InferenceObserver } from "@clavia/tardigrade-agent"
import type { Action } from "@clavia/tardigrade-agent/log/events"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import type { ModelConfig, ModelCredentials } from "./config"
import type { ModelCatalogState } from "./catalog"
import type { ModelAdapterRegistry } from "./adapter"
import { providerAvailabilitiesOf } from "./catalog-availability"
import { infer } from "./model"

export interface ModelHostConfig {
  readonly model: ModelConfig
  readonly modelCredentials: ModelCredentials
}

// The model binding the configured references name. An absent reference is not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
export const MISSING_MODEL = "no model provider is configured: run `tdg setup`"

interface SelectedModel {
  readonly model_id: string
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("@clavia/tardigrade-agent/inference/usage").ModelPricing
  readonly catalogRevision: string
}

interface ProviderConnection {
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
}

const connectionFrom = (
  config: ModelConfig,
  credentials: ModelCredentials,
  selected: ModelRef
): ProviderConnection => {
  const provider = config.providers[selected.provider]
  if (provider === undefined) {
    const available = Object.keys(config.providers).sort()
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} is not configured for model ${JSON.stringify(selected.model_id)}; ` +
      `run \`tdg setup\`${available.length === 0 ? "" : `; configured providers: ${available.join(", ")}`}`
    )
  }
  const apiKey = provider.env.flatMap((name) => credentials[name] === undefined ? [] : [credentials[name]!])[0]
  if (apiKey === undefined) {
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} needs a credential; set ${provider.env.join(" or ")} as a secret environment variable`
    )
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey,
    protocol: provider.protocol,
    ...(provider.region === undefined ? {} : { region: provider.region })
  }
}

const catalogModelFrom = (
  snapshot: ModelCatalog,
  selected: ModelRef
): ModelCatalog["providers"][number]["models"][number] => {
  const provider = snapshot.providers.find((candidate) => candidate.id === selected.provider)
  if (provider === undefined) {
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} is absent from model catalog revision ${JSON.stringify(snapshot.revision)}`
    )
  }
  const model = provider.models.find((candidate) => candidate.id === selected.model_id)
  if (model === undefined) {
    throw new Error(
      `model ${selected.provider}/${selected.model_id} is absent from model catalog revision ${JSON.stringify(snapshot.revision)}`
    )
  }
  return model
}

// selectedModelFrom combines one private provider connection with public metadata from the
// process catalog snapshot.
export const selectedModelFrom = (
  config: ModelConfig,
  credentials: ModelCredentials,
  catalog: ModelCatalogState,
  reference?: ModelRef
): SelectedModel => {
  const selected = reference ?? config.default
  if (selected === undefined) throw new Error("the built-in actor has no model reference; run `tdg setup`")
  if (!modelAllowedBy(config, selected)) {
    throw new Error(`model ${selected.provider}/${selected.model_id} is excluded by the host model policy`)
  }
  const provider = connectionFrom(config, credentials, selected)
  if (catalog.snapshot === undefined) {
    throw new Error(`model catalog metadata is unavailable for ${selected.provider}/${selected.model_id}; check the server startup logs`)
  }
  const catalogModel = catalogModelFrom(catalog.snapshot, selected)
  const metadata = catalogModel.metadata
  if (metadata.contextWindowTokens === undefined) {
    throw new Error(`model catalog has no context window for ${selected.provider}/${selected.model_id}`)
  }
  return {
    ...selected,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
    ...(provider.region === undefined ? {} : { region: provider.region }),
    contextWindowTokens: metadata.contextWindowTokens,
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.pricing === undefined ? {} : { pricing: metadata.pricing }),
    catalogRevision: catalog.snapshot.revision
  }
}

// modelIsConfigured says whether a turn can reach a model at all. The command line reads it to say
// so once on boot rather than letting every turn be the first news (apps/cli/src/commands.ts).
export const modelIsConfigured = (config: ModelHostConfig): boolean =>
  (() => {
    try {
      if (config.model.default === undefined) return false
      if (!modelAllowedBy(config.model, config.model.default)) return false
      connectionFrom(config.model, config.modelCredentials, config.model.default)
      return true
    } catch {
      return false
    }
  })()

export const modelLayer = (
  config: ModelHostConfig,
  catalog: ModelCatalogState,
  adapters: ModelAdapterRegistry,
  observer?: InferenceObserver
): Layer.Layer<Infer> => {
  if (Object.keys(config.model.providers).length === 0) {
    const failed: Action = { kind: "fail", error: MISSING_MODEL, failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({
      resolve: () => { throw new Error(MISSING_MODEL) },
      react: () => Effect.succeed(failed)
    })
  }
  const availableModels = (): ModelPolicy => {
    const snapshot = catalog.snapshot
    if (snapshot === undefined) return { allow: [] }
    const availability = providerAvailabilitiesOf(config.model, config.modelCredentials)
    const configured: ModelPolicy = {
      allow: snapshot.providers.flatMap((provider) =>
        availability[provider.id]?.status === "available" && provider.models.length > 0
          ? [{ provider: provider.id, model_ids: provider.models.map((model) => model.id) }]
          : []
      )
    }
    const authority = intersectModelPolicies([config.model, configured])
    return { ...authority, ...(config.model.default === undefined ? {} : { default: config.model.default }) }
  }
  return Layer.succeed(Infer, {
    resolve: (reference) => {
      const selected = selectedModelFrom(config.model, config.modelCredentials, catalog, reference)
      return {
        model: { provider: selected.provider, model_id: selected.model_id },
        models: availableModels(),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    react: (request, key, signal, onDelta) => Effect.suspend(() => {
      let selected: SelectedModel
      try {
        selected = selectedModelFrom(config.model, config.modelCredentials, catalog, request.model)
      } catch (error) {
        return Effect.succeed<Action>({
          kind: "fail",
          error: error instanceof Error ? error.message : String(error),
          failure: { cause: "inference_error", attempts: 0 }
        })
      }
      const binding = infer({
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        model: selected.model_id,
        protocol: selected.protocol,
        provider: selected.provider,
        ...(selected.region === undefined ? {} : { region: selected.region }),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        ...(selected.pricing === undefined ? {} : { pricing: selected.pricing })
      }, adapters, observer === undefined ? {} : { observer })
      return Effect.flatMap(Infer, (model) => model.react(request, key, signal, onDelta)).pipe(Effect.provide(binding))
    })
  })
}

