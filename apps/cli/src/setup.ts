import { Console, Data, Effect, Layer, Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FileSystem, type FileSystem as FileSystemService } from "effect/FileSystem"
import { Prompt } from "effect/unstable/cli"
import { applyEdits, modify } from "jsonc-parser"
import { BunFileSystem } from "@effect/platform-bun"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import {
  MODEL_PROTOCOLS,
  MODEL_PROVIDER_CONNECTIONS,
  modelProviderConnectionOf,
  modelProtocolOf,
  type ModelProtocol
} from "@clavia/tardigrade-model/directory"
import { loadModelCatalog } from "@clavia/tardigrade-server/catalog"
import { layerFileModelCatalogRepository } from "@clavia/tardigrade-server/catalog-repository"
import {
  TARDIGRADE_CONFIG_VAR,
  type Env,
  type ModelConfig
} from "@clavia/tardigrade-server/config"
import {
  DEFAULT_MODEL_CATALOG_URL,
  modelsDevCatalogOf
} from "@clavia/tardigrade-model/metadata"

import { parseProjectConfig, projectConfigPathIn } from "./config"

// Interactive `tdg setup` collects provider connections and chooses the project default before writing either file.
//
// An entered credential is written and never shown. It is absent from the printed summary, `--json`, and
// failures, so a shared terminal has no value to scrub (setup.test.ts, "the key is never echoed").

// SECRETS_MODE leaves the environment file readable and writable by its owner alone.
export const SECRETS_MODE = 0o600
export const ENV_FILE = ".dev.vars"
export const GITIGNORE_FILE = ".gitignore"

export const envPathIn = (root: string): string => `${root.replace(/\/$/, "")}/${ENV_FILE}`
export const gitignorePathIn = (root: string): string => `${root.replace(/\/$/, "")}/${GITIGNORE_FILE}`

// DEFAULT_MODEL_LIST_TIMEOUT_MILLIS bounds the optional model catalog request.
export const DEFAULT_MODEL_LIST_TIMEOUT_MILLIS = 10_000

// Preset is one entry in the provider select. `baseUrl` prefills the next prompt and stays
// editable; an absent one asks with no default. `provider` names the endpoint's vendor, which
// also selects a protocol other than the OpenAI-compatible one the model binding speaks by
// default (platform/model/src/model.ts).
//
// The list is short on purpose. Every URL here is a promise to keep it correct, so an endpoint this
// repository does not track belongs behind "Other" rather than in the list.
export interface Preset {
  readonly title: string
  readonly description: string
  readonly baseUrl?: string
  readonly provider?: string
  readonly protocol?: ModelProtocol
  readonly modelExample?: string
  readonly credential?: string
  readonly modelsUrl?: string
}

const PRESET_DETAILS: Readonly<Record<string, Omit<Preset, "title" | "provider" | "protocol" | "baseUrl">>> = {
  openai: {
    description: "OpenAI's Responses API",
    modelExample: "gpt-5.2",
    credential: "OpenAI API key",
    modelsUrl: "https://platform.openai.com/docs/models"
  },
  anthropic: {
    description: "Anthropic's Messages protocol",
    modelExample: "claude-sonnet-4-6",
    credential: "Anthropic API key",
    modelsUrl: "https://docs.anthropic.com/en/docs/about-claude/models"
  },
  openrouter: {
    description: "One key across many model creators",
    modelExample: "anthropic/claude-sonnet-latest",
    credential: "OpenRouter API key",
    modelsUrl: "https://openrouter.ai/models"
  },
  vercel: {
    description: "One Vercel key across model creators",
    modelExample: "anthropic/claude-opus-5",
    credential: "Vercel AI Gateway API key",
    modelsUrl: "https://vercel.com/ai-gateway/models"
  },
  "cloudflare-ai-gateway": {
    description: "Cloudflare's account-scoped Responses endpoint",
    modelExample: "openai/gpt-5.6-luna",
    credential: "Cloudflare API token",
    modelsUrl: "https://developers.cloudflare.com/ai-gateway/models/"
  },
  azure: {
    description: "Microsoft Foundry's OpenAI v1 endpoint",
    modelExample: "deployment-name",
    credential: "Azure AI API key",
    modelsUrl: "https://ai.azure.com/explore/models"
  },
  google: {
    description: "The Gemini API from Google AI Studio",
    modelExample: "gemini-3.7-flash",
    credential: "Gemini API key",
    modelsUrl: "https://ai.google.dev/gemini-api/docs/models"
  },
  "google-vertex": {
    description: "Vertex AI's OpenAI-compatible endpoint",
    modelExample: "google/gemini-2.5-pro",
    credential: "Google access token",
    modelsUrl: "https://console.cloud.google.com/vertex-ai/model-garden"
  },
  "amazon-bedrock": {
    description: "Bedrock Converse through Cloudflare AI Gateway",
    credential: "AI Gateway API key"
  }
}

export const PRESETS: ReadonlyArray<Preset> = [
  ...MODEL_PROVIDER_CONNECTIONS.map((connection): Preset => ({
    title: connection.name,
    provider: connection.id,
    protocol: connection.protocol,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
    ...PRESET_DETAILS[connection.id]!
  })),
  {
    title: "Other",
    description: "A model endpoint whose protocol you declare"
  }
]

// ProviderAnswers is one provider connection and an optional credential entered at a prompt.
export interface ProviderAnswers {
  readonly provider: string
  readonly baseUrl: string
  readonly credential?: string
  readonly protocol: ModelProtocol
  readonly env: ReadonlyArray<string>
  readonly region?: string
}

// SetupAnswers is one provider connection paired with the model selected as the host default.
export interface SetupAnswers extends ProviderAnswers {
  readonly model_id: string
}

// SetupPlan holds every connection and the default model reference confirmed by the guided flow.
export interface SetupPlan {
  readonly providers: ReadonlyArray<ProviderAnswers>
  readonly default: NonNullable<ModelConfig["default"]>
}

const nonEmpty = (what: string) => (value: string): Effect.Effect<string, string> =>
  value.trim().length === 0 ? Effect.fail(`${what} cannot be empty`) : Effect.succeed(value.trim())

export interface ListedModel {
  readonly id: string
  readonly name?: string
}

export interface ModelCatalogOptions {
  readonly cachePath?: string
  readonly fetch?: typeof globalThis.fetch
  readonly selectionPolicy?: ModelSelectionPolicy
  readonly timeoutMillis?: number
  readonly url?: string
}

export interface ModelSelectionPolicy {
  readonly outputModality?: string
  readonly requireToolCalls: boolean
}

export interface ModelSelectionCapabilities {
  readonly outputModalities?: ReadonlyArray<string> | undefined
  readonly toolCall?: boolean | undefined
}

// DEFAULT_AGENT_MODEL_SELECTION_POLICY keeps models whose catalog metadata does not disprove text output or tool use.
export const DEFAULT_AGENT_MODEL_SELECTION_POLICY: ModelSelectionPolicy = {
  outputModality: "text",
  requireToolCalls: true
}

// agentModelIsSelectable applies declared catalog capabilities and keeps models with missing capability data.
export const agentModelIsSelectable = (
  capabilities: ModelSelectionCapabilities,
  policy: ModelSelectionPolicy = DEFAULT_AGENT_MODEL_SELECTION_POLICY
): boolean => {
  const outputs = capabilities.outputModalities
  if (policy.outputModality !== undefined && outputs !== undefined && !outputs.includes(policy.outputModality)) {
    return false
  }
  return policy.requireToolCalls !== true || capabilities.toolCall !== false
}

const selectionLabel = (policy: ModelSelectionPolicy): string => {
  const capabilities = [
    ...(policy.outputModality === undefined ? [] : [`${policy.outputModality} output`]),
    ...(policy.requireToolCalls ? ["tool calls"] : [])
  ]
  return capabilities.length === 0 ? "" : ` · ${capabilities.join(" and ")}`
}

export interface SetupPromptOptions {
  readonly current?: {
    readonly provider?: string | undefined
    readonly baseUrl?: string | undefined
    readonly model_id?: string | undefined
    readonly protocol?: string | undefined
    readonly env?: ReadonlyArray<string> | undefined
    readonly region?: string | undefined
  }
  readonly catalog?: ModelCatalogOptions
}

export interface SetupFlowPromptOptions extends SetupPromptOptions {
  readonly existing?: ModelConfig
}

type ModelPick = { readonly tag: "model"; readonly model: ListedModel } | { readonly tag: "manual" }

const listedCatalogModels = (
  models: ModelCatalog["providers"][number]["models"],
  policy: ModelSelectionPolicy
): ReadonlyArray<ListedModel> =>
  models.filter((model) => agentModelIsSelectable(model.metadata, policy)).map((model) => ({
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name })
  }))

export const modelsDevAt = async (
  provider: string,
  options: ModelCatalogOptions = {}
): Promise<{
  readonly revision: string
  readonly status: "fresh" | "cached"
  readonly env: ReadonlyArray<string>
  readonly models: ReadonlyArray<ListedModel>
}> => {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_MODEL_LIST_TIMEOUT_MILLIS
  const url = options.url ?? DEFAULT_MODEL_CATALOG_URL
  const selectionPolicy = options.selectionPolicy ?? DEFAULT_AGENT_MODEL_SELECTION_POLICY
  if (options.cachePath !== undefined) {
    const repository = layerFileModelCatalogRepository(options.cachePath).pipe(Layer.provide(BunFileSystem.layer))
    const state = await Effect.runPromise(loadModelCatalog({
      sourceUrl: url,
      timeoutMillis,
      policy: "cache-first",
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    }).pipe(Effect.provide(repository)))
    if (state.snapshot === undefined) throw new Error(state.refreshError ?? state.cacheError ?? "model catalog is unavailable")
    const found = state.snapshot.providers.find((entry) => entry.id === provider)
    return {
      revision: state.snapshot.revision,
      status: state.snapshot.status,
      env: found?.env ?? [],
      models: found === undefined ? [] : listedCatalogModels(found.models, selectionPolicy)
    }
  }
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMillis)
  })
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`)
  const revision = response.headers.get("etag") ?? response.headers.get("last-modified") ?? "unversioned"
  const found = modelsDevCatalogOf(await response.json()).find((entry) => entry.id === provider)
  return {
    revision,
    status: "fresh",
    env: found?.env ?? [],
    models: found?.models.filter((model) => agentModelIsSelectable({
      outputModalities: model.metadata.outputModalities,
      toolCall: model.metadata.toolCall
    }, selectionPolicy)).map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name })
    })) ?? []
  }
}

type ModelCatalogResult = Awaited<ReturnType<typeof modelsDevAt>>

interface PromptedProvider {
  readonly answers: ProviderAnswers
  readonly catalog?: ModelCatalogResult
  readonly preset: Preset
}

const catalogResultFor = (provider: string, options: SetupPromptOptions) =>
  Effect.tryPromise(() => modelsDevAt(provider, options.catalog)).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (result) => result })
  )

const presetFor = (provider: string): Preset =>
  PRESETS.find((preset) => preset.provider === provider) ?? PRESETS[PRESETS.length - 1]!

const providerPrompt = (options: SetupPromptOptions) => Effect.gen(function*() {
  const preset = yield* Prompt.select({
    message: "Which model provider?",
    choices: PRESETS.map((preset) => ({ title: preset.title, value: preset, description: preset.description }))
  })
  const provider = preset.provider ?? (yield* Prompt.text({
    message: "Provider name",
    ...(options.current?.provider === undefined ? {} : { default: options.current.provider }),
    validate: nonEmpty("the provider name")
  }))
  const protocol = preset.protocol ?? (yield* Prompt.select<ModelProtocol>({
    message: "Which protocol does this endpoint accept?",
    choices: MODEL_PROTOCOLS.map((protocol) => ({ title: protocol, value: protocol }))
  }))
  const defaultBaseUrl = (options.current?.provider === provider ? options.current.baseUrl : undefined) ?? preset.baseUrl
  const baseUrl = yield* Prompt.text({
    message: preset.provider === "amazon-bedrock" ? "AI Gateway Bedrock endpoint" : "Base URL",
    ...(defaultBaseUrl === undefined ? {} : { default: defaultBaseUrl }),
    validate: nonEmpty("the base URL")
  })
  const region = provider === "amazon-bedrock" ? yield* Prompt.text({
    message: "AWS region",
    ...(options.current?.provider === provider && options.current.region !== undefined
      ? { default: options.current.region }
      : {}),
    validate: nonEmpty("the AWS region")
  }) : undefined
  const catalogResult = yield* catalogResultFor(provider, options)
  const suggestedEnv = (options.current?.provider === provider ? options.current.env?.[0] : undefined) ?? catalogResult?.env[0]
  const credentialEnv = yield* Prompt.text({
    message: "Credential environment variable",
    ...(suggestedEnv === undefined ? {} : { default: suggestedEnv }),
    validate: nonEmpty("the credential environment variable")
  })
  const credential = yield* Prompt.password({
    message: `${preset.credential ?? "API key"} for ${credentialEnv}`,
    validate: nonEmpty("the API key")
  })
  return {
    answers: {
      provider,
      baseUrl,
      credential: Redacted.value(credential),
      protocol,
      env: [credentialEnv, ...(catalogResult?.env ?? []).filter((name) => name !== credentialEnv)],
      ...(region === undefined ? {} : { region })
    },
    preset,
    ...(catalogResult === undefined ? {} : { catalog: catalogResult })
  } satisfies PromptedProvider
})

const modelPrompt = (
  provider: string,
  preset: Preset,
  options: SetupPromptOptions,
  discovered?: ModelCatalogResult
) => Effect.gen(function*() {
  const catalogResult = discovered ?? (yield* catalogResultFor(provider, options))
  const loaded = catalogResult?.models
  const current = options.current?.provider === provider ? options.current.model_id?.trim() : undefined
  const catalog = preset.modelsUrl === undefined ? "" : ` · Browse ${preset.modelsUrl}`
  const cache = catalogResult?.status === "cached" ? " · cached catalog" : ""
  const selection = selectionLabel(options.catalog?.selectionPolicy ?? DEFAULT_AGENT_MODEL_SELECTION_POLICY)
  const manual = () => Prompt.text({
    message: `${preset.modelExample === undefined ? "Default model ID" : `Default model ID, for example ${preset.modelExample}`}${catalog}`,
    ...(current === undefined || current.length === 0 ? {} : { default: current }),
    validate: nonEmpty("the model ID")
  })
  let selected: ListedModel
  if (loaded === undefined || loaded.length === 0) {
    yield* Console.log(`Could not load ${provider} from ${options.catalog?.url ?? DEFAULT_MODEL_CATALOG_URL}. Enter a model ID manually.`)
    selected = { id: yield* manual() }
  } else {
    const models = [...loaded]
    if (current !== undefined && current.length > 0 && !models.some((model) => model.id === current)) {
      models.unshift({ id: current, name: "Currently configured" })
    }
    const picked = yield* Prompt.autoComplete<ModelPick>({
      message: `Choose the default model${selection}${cache}${catalog}`,
      filterLabel: "model",
      filterPlaceholder: "type to filter",
      choices: [
        ...models.map((model) => ({
          title: model.id,
          value: { tag: "model", model } as const,
          ...(model.name === undefined || model.name === model.id ? {} : { description: model.name }),
          ...(model.id === current ? { selected: true } : {})
        })),
        { title: "Enter a model ID manually", value: { tag: "manual" } as const }
      ]
    })
    selected = picked.tag === "model" ? picked.model : { id: yield* manual() }
  }
  return selected.id
})

// setupProviderPrompt collects one provider connection without changing the project default.
export const setupProviderPrompt = (options: SetupPromptOptions = {}) =>
  Effect.map(providerPrompt(options), (prompted) => prompted.answers)

// setupDefaultPrompt chooses a model reference from configured provider connections.
export const setupDefaultPrompt = (
  providers: ReadonlyArray<string>,
  options: SetupPromptOptions = {}
) => Effect.gen(function*() {
  if (providers.length === 0) return yield* Effect.fail("no provider connection is configured; run `tdg setup provider`")
  const provider = yield* Prompt.select<string>({
    message: "Which provider should be the project default?",
    choices: [...providers].sort().map((provider) => ({
      title: provider,
      value: provider,
      ...(provider === options.current?.provider ? { selected: true } : {})
    }))
  })
  return {
    provider,
    model_id: yield* modelPrompt(provider, presetFor(provider), options)
  }
})

// setupPrompt collects the single provider and default used during project initialization.
export const setupPrompt = (options: SetupPromptOptions = {}) => Effect.gen(function*() {
  const prompted = yield* providerPrompt(options)
  return {
    ...prompted.answers,
    model_id: yield* modelPrompt(prompted.answers.provider, prompted.preset, options, prompted.catalog)
  } satisfies SetupAnswers
})

export const setupPlanReview = (plan: SetupPlan): string => [
  "providers",
  ...plan.providers.map((provider) => [
    `  ${provider.provider}  ${provider.baseUrl}  ${provider.env[0]}`,
    ...(provider.region === undefined ? [] : [`    region  ${provider.region}`])
  ].join("\n")),
  `default  ${plan.default.provider}/${plan.default.model_id}`
].join("\n")

// setupFlowPrompt collects provider connections, chooses the default once, and confirms the write.
export const setupFlowPrompt = (options: SetupFlowPromptOptions = {}) => Effect.gen(function*() {
  const added = new Map<string, PromptedProvider>()
  for (;;) {
    const prompted = yield* providerPrompt(options)
    added.set(prompted.answers.provider, prompted)
    const more = yield* Prompt.confirm({ message: "Add another provider?", initial: false })
    if (!more) break
  }
  const providerNames = [...new Set([
    ...Object.keys(options.existing?.providers ?? {}),
    ...added.keys()
  ])]
  const provider = yield* Prompt.select<string>({
    message: "Which provider should be the project default?",
    choices: providerNames.sort().map((provider) => ({
      title: provider,
      value: provider,
      ...(provider === options.existing?.default?.provider ? { selected: true } : {})
    }))
  })
  const prompted = added.get(provider)
  const current = options.existing?.default
  const defaultModel = yield* modelPrompt(provider, prompted?.preset ?? presetFor(provider), current === undefined
    ? options
    : { ...options, current: { provider: current.provider, model_id: current.model_id } }, prompted?.catalog)
  const plan: SetupPlan = {
    providers: [...added.values()].map((entry) => entry.answers),
    default: { provider, model_id: defaultModel }
  }
  yield* Console.log(setupPlanReview(plan))
  return (yield* Prompt.confirm({ message: "Continue?", initial: true })) ? plan : undefined
})

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

class SetupConfigError extends Data.TaggedError("SetupConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface SetupFlags {
  readonly provider?: string | undefined
  readonly providerConfig?: string | undefined
  readonly defaultModel?: string | undefined
}

export interface ProviderSetupInput {
  readonly provider?: string | undefined
  readonly config?: string | undefined
}

export interface DefaultSetupFlags {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

const providerObjectOf = (source: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error("provider config must be valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("provider config must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

const providerString = (config: Record<string, unknown>, name: string): string | undefined => {
  const value = config[name]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`provider config ${name} must be a non-empty string`)
  }
  return value.trim()
}

const providerEnv = (config: Record<string, unknown>): ReadonlyArray<string> => {
  if (!Array.isArray(config["env"]) || config["env"].length === 0) {
    throw new Error("provider config env must be a non-empty array of environment variable names")
  }
  const env = config["env"].map((value) => {
    if (typeof value !== "string" || !ENV_NAME.test(value.trim())) {
      throw new Error(`provider config env entries must match ${ENV_NAME}`)
    }
    return value.trim()
  })
  return [...new Set(env)]
}

// providerAnswersFrom resolves one declarative provider connection without reading its secrets.
export const providerAnswersFrom = (
  input: ProviderSetupInput
): ProviderAnswers | undefined => {
  const provider = input.provider?.trim()
  const source = input.config?.trim()
  if (provider === undefined && source === undefined) return undefined
  if (provider === undefined || provider.length === 0 || source === undefined || source.length === 0) {
    throw new Error("tdg setup provider requires both <provider> and <config> when either argument is used")
  }
  const config = providerObjectOf(source)
  const allowed = new Set(["baseUrl", "protocol", "env", "region"])
  const unknown = Object.keys(config).filter((name) => !allowed.has(name))
  if (unknown.length > 0) throw new Error(`provider config contains unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}`)
  const connection = modelProviderConnectionOf(provider)
  const statedProtocol = providerString(config, "protocol")
  const declaredProtocol = statedProtocol === undefined ? undefined : modelProtocolOf(statedProtocol)
  if (connection !== undefined && declaredProtocol !== undefined && declaredProtocol !== connection.protocol) {
    throw new Error(`provider ${JSON.stringify(provider)} uses protocol ${JSON.stringify(connection.protocol)}`)
  }
  const protocol = connection?.protocol ?? declaredProtocol
  if (protocol === undefined) throw new Error(`provider ${JSON.stringify(provider)} must declare protocol`)
  const baseUrl = providerString(config, "baseUrl") ?? connection?.baseUrl
  if (baseUrl === undefined) throw new Error(`provider ${JSON.stringify(provider)} must declare baseUrl`)
  const region = providerString(config, "region")
  if (protocol === "bedrock-converse" && region === undefined) {
    throw new Error(`provider ${JSON.stringify(provider)} must declare region for protocol ${JSON.stringify(protocol)}`)
  }
  if (protocol !== "bedrock-converse" && region !== undefined) {
    throw new Error(`provider ${JSON.stringify(provider)} cannot declare region with protocol ${JSON.stringify(protocol)}`)
  }
  return {
    provider,
    baseUrl,
    protocol,
    env: providerEnv(config),
    ...(region === undefined ? {} : { region })
  }
}

// defaultModelFrom resolves one declarative default model reference without changing its provider connection.
export const defaultModelFrom = (flags: DefaultSetupFlags): NonNullable<ModelConfig["default"]> | undefined => {
  const provider = flags.provider?.trim()
  const model_id = flags.model?.trim()
  if (provider === undefined && model_id === undefined) return undefined
  const missing = [
    ...(provider === undefined || provider.length === 0 ? ["--provider"] : []),
    ...(model_id === undefined || model_id.length === 0 ? ["--model"] : [])
  ]
  if (missing.length > 0) throw new Error(`tdg setup default requires ${missing.join(", ")} when default flags are used`)
  return { provider: provider!, model_id: model_id! }
}

// setupAnswersFrom resolves a declarative provider connection and its initial default model.
export const setupAnswersFrom = (
  flags: SetupFlags,
  command: "tdg init" | "tdg setup" = "tdg setup"
): SetupAnswers | undefined => {
  const fields = {
    provider: flags.provider?.trim(),
    "provider-config": flags.providerConfig?.trim(),
    "default-model": flags.defaultModel?.trim()
  }
  if (Object.values(fields).every((value) => value === undefined)) return undefined
  const missing = Object.entries(fields).flatMap(([name, value]) => value === undefined || value.length === 0 ? [`--${name}`] : [])
  if (missing.length > 0) throw new Error(`${command} requires ${missing.join(", ")} when declarative provider options are used`)
  const provider = providerAnswersFrom({
    provider: fields.provider,
    config: fields["provider-config"]
  })!
  return {
    ...provider,
    model_id: fields["default-model"]!
  }
}

const valueOf = (source: string): string => {
  const value = source.trim()
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === "string" ? parsed : value
    } catch {
      return value
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value.replace(/\s+#.*$/, "").trim()
}

// setupEnvironmentOf reads assignments written by common dotenv formats. It is also used after an
// interactive first boot so that process configuration and the file written during that process agree.
export const setupEnvironmentOf = (raw: string): Env => {
  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const found = assignment.exec(line)
    if (found !== null) env[found[1]!] = valueOf(found[2]!)
  }
  return env
}

// runtimeEnvironmentOf applies local development secrets before process environment values (setup.test.ts, "process credentials override local development values").
export const runtimeEnvironmentOf = (env: Env, local: Env): Env => ({ ...local, ...env })

const withAssignments = (raw: string, values: Readonly<Record<string, string>>): string => {
  const pending = new Set(Object.keys(values))
  const lines = raw.length === 0 ? [] : raw.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
  const next = lines.flatMap((line) => {
    const found = assignment.exec(line)
    if (found === null || values[found[1]!] === undefined) return [line]
    const name = found[1]!
    if (!pending.delete(name)) return []
    return [`${name}=${JSON.stringify(values[name])}`]
  })
  for (const name of pending) next.push(`${name}=${JSON.stringify(values[name])}`)
  return `${next.join("\n")}\n`
}

const withSecretsIgnored = (raw: string): string => {
  const normalized = raw.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines.some((line) => line.trim() === ".dev.vars" || line.trim() === ".dev.vars*")) return normalized
  const prefix = normalized.length === 0 || normalized.endsWith("\n") ? normalized : `${normalized}\n`
  return `${prefix}.dev.vars*\n`
}

const readOrEmpty = (fs: FileSystemService, path: string): Effect.Effect<string, PlatformError> =>
  fs.readFileString(path).pipe(
    Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed("") : error)
  )

export interface SetupFiles {
  readonly configPath: string
  readonly secretsPath: string
}

const updatedProject = (
  raw: string,
  selected: NonNullable<ModelConfig["default"]> | undefined,
  providers: ReadonlyArray<ProviderAnswers>
): string => {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  let next = raw.trim().length === 0 ? "{}\n" : raw
  for (const provider of providers) {
    next = applyEdits(next, modify(next, ["vars", TARDIGRADE_CONFIG_VAR, "models", "providers", provider.provider], {
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      env: provider.env,
      ...(provider.region === undefined ? {} : { region: provider.region })
    }, { formattingOptions }))
  }
  if (selected !== undefined) {
    next = applyEdits(next, modify(next, ["vars", TARDIGRADE_CONFIG_VAR, "models", "default"], selected, { formattingOptions }))
  }
  return next.endsWith("\n") ? next : `${next}\n`
}

const writeSetupChanges = (
  root: string,
  providers: ReadonlyArray<ProviderAnswers>,
  selected: NonNullable<ModelConfig["default"]> | undefined,
  env: Env = {}
): Effect.Effect<SetupFiles, PlatformError | SetupConfigError, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    for (const provider of providers) {
      if (provider.env.length === 0 || provider.env.some((name) => !ENV_NAME.test(name))) {
        return yield* new SetupConfigError({ message: `credential environment variable must match ${ENV_NAME}` })
      }
    }
    const configPath = projectConfigPathIn(root, env)
    const foundConfig = yield* readOrEmpty(fs, configPath)
    const configRaw = foundConfig.trim().length === 0 ? "{}\n" : foundConfig
    yield* Effect.try({
      try: () => parseProjectConfig(configRaw, configPath),
      catch: (cause) => new SetupConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      })
    })
    const secretsPath = envPathIn(root)
    yield* fs.writeFileString(
      configPath,
      updatedProject(configRaw, selected, providers)
    )
    const credentials = Object.fromEntries(providers.flatMap((provider) =>
      provider.credential === undefined ? [] : [[provider.env[0]!, provider.credential]]
    ))
    if (Object.keys(credentials).length > 0) {
      const secretsRaw = yield* readOrEmpty(fs, secretsPath)
      yield* fs.writeFileString(
        secretsPath,
        withAssignments(secretsRaw, credentials),
        { mode: SECRETS_MODE }
      )
      // The mode is set again after the write, because `mode` applies when a file is created and this
      // may have replaced one that already existed at a wider mode (setup.test.ts).
      yield* fs.chmod(secretsPath, SECRETS_MODE)
      const gitignorePath = gitignorePathIn(root)
      const gitignoreRaw = yield* readOrEmpty(fs, gitignorePath)
      yield* fs.writeFileString(gitignorePath, withSecretsIgnored(gitignoreRaw))
    }
    return { configPath, secretsPath }
  })

// writeSetup merges one connection and selects its model as the project default.
export const writeSetup = (
  root: string,
  answers: SetupAnswers,
  env: Env = {}
): Effect.Effect<SetupFiles, PlatformError | SetupConfigError, FileSystem> =>
  writeSetupChanges(root, [answers], { provider: answers.provider, model_id: answers.model_id }, env)

// writeProviderSetup merges provider connections without changing the project default.
export const writeProviderSetup = (
  root: string,
  providers: ReadonlyArray<ProviderAnswers>,
  env: Env = {}
): Effect.Effect<SetupFiles, PlatformError | SetupConfigError, FileSystem> =>
  writeSetupChanges(root, providers, undefined, env)

// writeDefaultSetup changes the project default without writing credentials.
export const writeDefaultSetup = (
  root: string,
  selected: NonNullable<ModelConfig["default"]>,
  env: Env = {}
): Effect.Effect<SetupFiles, PlatformError | SetupConfigError, FileSystem> =>
  writeSetupChanges(root, [], selected, env)

// writeSetupPlan writes every collected connection and the selected default in one pass.
export const writeSetupPlan = (
  root: string,
  plan: SetupPlan,
  env: Env = {}
): Effect.Effect<SetupFiles, PlatformError | SetupConfigError, FileSystem> =>
  writeSetupChanges(root, plan.providers, plan.default, env)

export const readSetupEnv = (root: string): Effect.Effect<Env, never, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    const raw = yield* fs.readFileString(envPathIn(root)).pipe(Effect.orElseSucceed(() => ""))
    return setupEnvironmentOf(raw)
  })

// setupSummary prints where an entered credential was stored without showing its value.
export const setupSummary = (files: SetupFiles, answers: SetupAnswers): string =>
  [
    `wrote ${files.configPath}`,
    ...(answers.credential === undefined ? [] : [`stored credential in ${files.secretsPath}`]),
    `provider ${answers.provider}`,
    `at    ${answers.baseUrl}`,
    `protocol ${answers.protocol}`,
    `secret ${answers.env[0]}`,
    ...(answers.region === undefined ? [] : [`region ${answers.region}`]),
    `default ${answers.model_id}`
  ].join("\n")

export const providerSetupSummary = (files: SetupFiles, providers: ReadonlyArray<ProviderAnswers>): string => [
  `wrote ${files.configPath}`,
  ...(providers.some((provider) => provider.credential !== undefined)
    ? [`stored credentials in ${files.secretsPath}`]
    : []),
  ...providers.flatMap((provider) => [
    `provider ${provider.provider}`,
    `at    ${provider.baseUrl}`,
    `protocol ${provider.protocol}`,
    `secret ${provider.env.join(" or ")}`,
    ...(provider.region === undefined ? [] : [`region ${provider.region}`])
  ])
].join("\n")

export const defaultSetupSummary = (files: SetupFiles, selected: NonNullable<ModelConfig["default"]>): string =>
  [`wrote ${files.configPath}`, `default ${selected.provider}/${selected.model_id}`].join("\n")

export const setupPlanSummary = (files: SetupFiles, plan: SetupPlan): string =>
  `${providerSetupSummary(files, plan.providers)}\n${defaultSetupSummary(files, plan.default).split("\n")[1]}`

export const setupJson = (files: SetupFiles, answers: SetupAnswers): {
  readonly configPath: string
  readonly secretsPath?: string
  readonly baseUrl: string
  readonly provider: string
  readonly model_id: string
  readonly protocol: ModelProtocol
  readonly credential: "environment" | "stored"
  readonly env: ReadonlyArray<string>
  readonly region?: string
} => ({
  configPath: files.configPath,
  ...(answers.credential === undefined ? {} : { secretsPath: files.secretsPath }),
  provider: answers.provider,
  baseUrl: answers.baseUrl,
  model_id: answers.model_id,
  protocol: answers.protocol,
  credential: answers.credential === undefined ? "environment" : "stored",
  env: answers.env,
  ...(answers.region === undefined ? {} : { region: answers.region })
})

export const providerSetupJson = (files: SetupFiles, providers: ReadonlyArray<ProviderAnswers>) => ({
  configPath: files.configPath,
  ...(providers.some((provider) => provider.credential !== undefined) ? { secretsPath: files.secretsPath } : {}),
  providers: providers.map((provider) => ({
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    credential: provider.credential === undefined ? "environment" as const : "stored" as const,
    env: provider.env,
    ...(provider.region === undefined ? {} : { region: provider.region })
  }))
})

export const defaultSetupJson = (files: SetupFiles, selected: NonNullable<ModelConfig["default"]>) => ({
  configPath: files.configPath,
  default: selected
})
