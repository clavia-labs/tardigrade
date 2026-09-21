import { Schema } from "effect"
import { ModelCatalogMetadata } from "./catalog/schema"
import { protocolOptionsOf, type ModelOptionsByProtocol } from "./providers/options"
import { modelRefOf } from "@clavia/tardigrade-model/reference"
import { modelAllowedBy, modelPolicyOf, type ModelPolicy } from "@clavia/tardigrade-model/access"
import { modelProtocolOf, type ModelProtocol } from "./providers/directory"

export type ModelProviderConfig<Options = never> = ProviderConnection & ({
  [P in ModelProtocol]: { readonly protocol: P; readonly models?: Readonly<Record<string, { readonly metadata?: typeof ModelCatalogMetadata.Type; readonly options?: [Options] extends [never] ? ModelOptionsByProtocol[P] : Options }>> }
}[ModelProtocol] | { readonly protocol: ModelProtocol; readonly models?: never })

interface ProviderConnection {
  readonly baseUrl: string
  readonly env: ReadonlyArray<string>
  readonly region?: string
}

// ModelConfig holds private provider connections and the reference used by the built-in actor.
export interface ModelConfig extends ModelPolicy {
  readonly providers: Readonly<Record<string, ModelProviderConfig | ModelProviderConfig<Schema.JsonObject>>>
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
}

// canonicalModelConfig serializes model configuration deterministically for deployment lock verification.
export const canonicalModelConfig = (config: ModelConfig): string => JSON.stringify(canonical(config))

export type ModelCredentials = Readonly<Record<string, string>>

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const found = stringOf(entry)
        return found === undefined ? [] : [found]
      })
    : []

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// modelSettingsOf validates provider options and model metadata (apps/cli/src/setup.test.ts).
export const modelSettingsOf = (protocol: ModelProtocol, value: unknown): Record<string, { readonly options?: Schema.JsonObject; readonly metadata?: typeof ModelCatalogMetadata.Type }> | undefined => {
  let models: Record<string, { readonly options?: Schema.JsonObject; readonly metadata?: typeof ModelCatalogMetadata.Type }> | undefined
  if (value !== undefined) {
    const entries = recordOf(value)
    if (entries === undefined || Array.isArray(entries)) throw new Error("models must map model IDs to settings")
    models = {}
    for (const [model, value] of Object.entries(entries)) {
      if (model.trim().length === 0) throw new Error("model ID cannot be empty")
      const settings = recordOf(value)
      if (settings === undefined || Array.isArray(settings)) throw new Error(`model ${model} settings must be an object`)
      if (Object.keys(settings).some((field) => field !== "options" && field !== "metadata")) throw new Error(`model ${model} contains unsupported settings`)
      const parsed = protocolOptionsOf(protocol, settings.options)
      const metadata = settings.metadata === undefined ? undefined : Schema.decodeUnknownSync(ModelCatalogMetadata, { onExcessProperty: "error" })(settings.metadata)
      models[model] = {
        ...(parsed.options === undefined ? {} : { options: parsed.options }),
        ...(metadata === undefined ? {} : { metadata })
      }
    }
  }
  return models
}

// modelConfigOf validates provider connections used by a directly hosted server.
export const modelConfigOf = (value: unknown): ModelConfig => {
  const source = recordOf(value)
  if (source === undefined) throw new Error("provider connection configuration must be a JSON object")
  const unknownModelFields = Object.keys(source).filter((name) => name !== "default" && name !== "fallback" && name !== "allow" && name !== "providers")
  if (unknownModelFields.length > 0) throw new Error(`models contains unknown fields: ${unknownModelFields.join(", ")}`)
  const providersSource = recordOf(source["providers"]) ?? {}
  const providers: Record<string, ModelProviderConfig<Schema.JsonObject>> = {}
  for (const [name, rawProvider] of Object.entries(providersSource)) {
    if (name.trim().length === 0) throw new Error("a model provider name cannot be empty")
    const provider = recordOf(rawProvider)
    if (provider === undefined) throw new Error(`provider ${JSON.stringify(name)} must be an object`)
    if (provider["apiKey"] !== undefined) {
      throw new Error(`provider ${JSON.stringify(name)} cannot contain apiKey; declare its secret environment variable in env`)
    }
    const allowed = new Set(["baseUrl", "protocol", "env", "region", "models"])
    const unknown = Object.keys(provider).filter((field) => !allowed.has(field))
    if (unknown.length > 0) throw new Error(`provider ${JSON.stringify(name)} contains unknown fields: ${unknown.join(", ")}`)
    const baseUrl = stringOf(provider["baseUrl"])
    const protocol = stringOf(provider["protocol"])
    const env = stringsOf(provider["env"])
    const region = stringOf(provider["region"])
    if (baseUrl === undefined) throw new Error(`provider ${JSON.stringify(name)} must declare baseUrl`)
    if (protocol === undefined) throw new Error(`provider ${JSON.stringify(name)} must declare protocol`)
    if (env.length === 0) throw new Error(`provider ${JSON.stringify(name)} must declare env`)
    const invalidEnv = env.find((entry) => !ENV_NAME.test(entry))
    if (invalidEnv !== undefined) throw new Error(`provider ${JSON.stringify(name)} env contains invalid name ${JSON.stringify(invalidEnv)}`)
    const selectedProtocol = modelProtocolOf(protocol)
    if (selectedProtocol === "bedrock-converse" && region === undefined) {
      throw new Error(`provider ${JSON.stringify(name)} must declare region for protocol ${JSON.stringify(selectedProtocol)}`)
    }
    if (selectedProtocol !== "bedrock-converse" && region !== undefined) {
      throw new Error(`provider ${JSON.stringify(name)} cannot declare region with protocol ${JSON.stringify(selectedProtocol)}`)
    }
    const models = modelSettingsOf(selectedProtocol, provider["models"])
    providers[name] = {
      ...(models === undefined ? {} : { models }),
      baseUrl,
      protocol: selectedProtocol,
      env,
      ...(region === undefined ? {} : { region })
    } as ModelProviderConfig<Schema.JsonObject>
  }
  const selectedValue = source["default"]
  const selected = modelRefOf(selectedValue)
  if (selectedValue !== undefined && selected === undefined) throw new Error("models.default must be { provider, model_id }")
  const configured = Object.keys(providers).length > 0
  if (configured && !("allow" in source)) throw new Error('models with providers must declare allow as "*" or an array')
  if (configured && selected === undefined) throw new Error("models with providers must declare default { provider, model_id }")
  const policy = modelPolicyOf({
    ...(selected === undefined ? {} : { default: selected }),
    ...(source["fallback"] === undefined ? {} : { fallback: source["fallback"] }),
    allow: source["allow"] ?? "*"
  })
  if (selected !== undefined && providers[selected.provider] === undefined) {
    throw new Error(`models.default names unconfigured provider ${JSON.stringify(selected.provider)}`)
  }
  if (selected !== undefined && !modelAllowedBy(policy, selected)) {
    throw new Error(`models.default ${selected.provider}/${selected.model_id} is excluded by models.allow`)
  }
  for (const model of policy.fallback ?? []) {
    if (providers[model.provider] === undefined) throw new Error(`models.fallback names unconfigured provider ${JSON.stringify(model.provider)}`)
  }
  return {
    ...policy,
    providers
  }
}
