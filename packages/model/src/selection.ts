import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { BindingSettings, CurrentModel, ModelSelection } from "@clavia/tardigrade-model/settings"
import { intersectModelPolicies, modelAllowedBy, type ModelPolicy } from "./access"
import type { ModelRef } from "./reference"
import type { ModelCatalog } from "@clavia/tardigrade-model/catalog/schema"
import type { ModelConfig, ModelCredentials } from "./config"
import type { ModelCatalogState } from "./catalog/index"
import { providerAvailabilitiesOf } from "./catalog/availability"

export interface ModelHostConfig {
  readonly model: ModelConfig
  readonly modelCredentials: ModelCredentials
}

// The model binding the configured references name. An absent reference is not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
export const MISSING_MODEL = "no model provider is configured: run `tdg setup`"

export interface SelectedModel {
  readonly model_id: string
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("@clavia/tardigrade-model/pricing").ModelPricing
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
  const contextWindowTokens = config.providers[selected.provider]?.models?.[selected.model_id]?.contextWindowTokens ?? metadata.contextWindowTokens
  if (contextWindowTokens === undefined) {
    throw new Error(`model catalog has no context window for ${selected.provider}/${selected.model_id}`)
  }
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error(`model ${selected.provider}/${selected.model_id} contextWindowTokens must be a positive safe integer`)
  return {
    ...selected,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
    ...(provider.region === undefined ? {} : { region: provider.region }),
    contextWindowTokens,
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

// modelLayerWith shares host selection and catalog authority across inference bindings.
export const modelLayerWith = (
  config: ModelHostConfig,
  catalog: ModelCatalogState,
  bindingFor: (selected: SelectedModel) => Layer.Layer<LanguageModel.LanguageModel>,
  protocols?: ReadonlyArray<SelectedModel["protocol"]>
): Layer.Layer<LanguageModel.LanguageModel> => {
  const select = (reference?: ModelRef) => {
    if (Object.keys(config.model.providers).length === 0) throw new Error(MISSING_MODEL)
    const selected = selectedModelFrom(config.model, config.modelCredentials, catalog, reference)
    if (protocols !== undefined && !protocols.includes(selected.protocol)) throw new Error(`inference binding does not support ${selected.protocol} for ${selected.provider}/${selected.model_id}`)
    return selected
  }
  const availableModels = (): ModelPolicy => {
    const snapshot = catalog.snapshot
    if (snapshot === undefined) return { allow: [] }
    const availability = providerAvailabilitiesOf(config.model, config.modelCredentials)
    const configured: ModelPolicy = {
      allow: snapshot.providers.flatMap((provider) =>
        availability[provider.id]?.status === "available" && provider.models.length > 0 && (protocols === undefined || protocols.includes(config.model.providers[provider.id]!.protocol))
          ? [{ provider: provider.id, model_ids: provider.models.map((model) => model.id) }]
          : []
      )
    }
    const authority = intersectModelPolicies([config.model, configured])
    return { ...authority, ...(config.model.default === undefined ? {} : { default: config.model.default }) }
  }
  const selection = Layer.succeed(ModelSelection, {
    resolve: (reference) => {
      const selected = select(reference)
      return {
        model: { provider: selected.provider, model_id: selected.model_id },
        models: availableModels(),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    settings: (reference) => Effect.suspend(() => {
      const selected = select(reference)
      return BindingSettings.pipe(Effect.provide(bindingFor(selected)))
    }),
  })
  const withModel = <A, E, R>(use: (native: LanguageModel.LanguageModel) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentModel, (reference) => Effect.flatMap(LanguageModel.LanguageModel, use).pipe(Effect.provide(bindingFor(select(reference)))))
  const model = Layer.succeed(LanguageModel.LanguageModel, {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    // generateText forwards caller toolkit services through Effect's overloaded signature.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    generateText: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.generateText>) => withModel((native) => native.generateText(...args))) as typeof LanguageModel.LanguageModel.Service.generateText,
    // generateObject forwards caller schema services through Effect's generic signature.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    generateObject: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.generateObject>) => withModel((native) => native.generateObject(...args))) as typeof LanguageModel.LanguageModel.Service.generateObject,
    streamText: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.streamText>) => Stream.unwrap(Effect.map(CurrentModel, (reference) => Stream.unwrap(Effect.map(LanguageModel.LanguageModel, (native) => native.streamText(...args))).pipe(Stream.provide(bindingFor(select(reference))))))) as typeof LanguageModel.LanguageModel.Service.streamText
  })
  return Layer.merge(selection, model)
}
