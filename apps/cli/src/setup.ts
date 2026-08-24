import { Console, Data, Effect, Layer, Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FileSystem, type FileSystem as FileSystemService } from "effect/FileSystem"
import { Prompt } from "effect/unstable/cli"
import { applyEdits, modify } from "jsonc-parser"
import { BunFileSystem } from "@effect/platform-bun"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { MODEL_DRIVERS, type ModelDriver } from "@clavia/tardigrade-model/directory"
import { loadModelCatalog } from "@clavia/tardigrade-server/catalog"
import { layerFileModelCatalogRepository } from "@clavia/tardigrade-server/catalog-repository"
import type { Env, ModelConfig } from "@clavia/tardigrade-server/config"
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
export const ENV_FILE = ".env"

export const envPathIn = (root: string): string => `${root.replace(/\/$/, "")}/${ENV_FILE}`

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
  readonly driver?: ModelDriver
  readonly modelExample?: string
  readonly credential?: string
  readonly modelsUrl?: string
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    title: "OpenAI",
    description: "The OpenAI-compatible protocol the binding speaks by default",
    // Named so the log records which vendor served a turn. It says nothing about structured
    // output: that promise belongs to the endpoint and the model together, and an operator
    // states it (platform/model/src/output.ts, capabilityOf).
    provider: "openai",
    driver: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    modelExample: "gpt-5.2",
    credential: "OpenAI API key",
    modelsUrl: "https://platform.openai.com/docs/models"
  },
  {
    title: "Anthropic",
    description: "Anthropic's Messages protocol",
    provider: "anthropic",
    driver: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelExample: "claude-sonnet-4-6",
    credential: "Anthropic API key",
    modelsUrl: "https://docs.anthropic.com/en/docs/about-claude/models"
  },
  {
    title: "OpenRouter",
    description: "One key across many providers, over the same protocol",
    provider: "openrouter",
    driver: "openai-chat-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    modelExample: "anthropic/claude-sonnet-latest",
    credential: "OpenRouter API key",
    modelsUrl: "https://openrouter.ai/models"
  },
  {
    title: "Vercel AI Gateway",
    description: "One Vercel key across providers, over the OpenAI-compatible protocol",
    provider: "vercel",
    driver: "openai-responses",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    modelExample: "anthropic/claude-opus-5",
    credential: "Vercel AI Gateway API key",
    modelsUrl: "https://vercel.com/ai-gateway/models"
  },
  {
    title: "Cloudflare AI Gateway",
    description: "Cloudflare's account-scoped Responses endpoint",
    provider: "cloudflare-ai-gateway",
    driver: "openai-responses",
    modelExample: "openai/gpt-5.6-luna",
    credential: "Cloudflare API token",
    modelsUrl: "https://developers.cloudflare.com/ai-gateway/models/"
  },
  {
    title: "Microsoft Foundry",
    description: "Microsoft Foundry's OpenAI v1 endpoint",
    provider: "azure",
    driver: "openai-responses",
    modelExample: "deployment-name",
    credential: "Azure AI API key",
    modelsUrl: "https://ai.azure.com/explore/models"
  },
  {
    title: "Google AI",
    description: "The Gemini API from Google AI Studio",
    provider: "google",
    driver: "openai-chat-completions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelExample: "gemini-3.7-flash",
    credential: "Gemini API key",
    modelsUrl: "https://ai.google.dev/gemini-api/docs/models"
  },
  {
    title: "Google Vertex AI",
    description: "Vertex AI's OpenAI-compatible endpoint",
    provider: "google-vertex",
    driver: "openai-chat-completions",
    modelExample: "google/gemini-2.5-pro",
    credential: "Google access token",
    modelsUrl: "https://console.cloud.google.com/vertex-ai/model-garden"
  },
  {
    title: "Amazon Bedrock",
    description: "Bedrock Converse through Cloudflare AI Gateway",
    provider: "amazon-bedrock",
    driver: "bedrock-converse",
    credential: "AI Gateway API key"
  },
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
  readonly driver: ModelDriver
  readonly env: ReadonlyArray<string>
  readonly region?: string
}

// SetupAnswers is one provider connection paired with the model selected as the host default.
export interface SetupAnswers extends ProviderAnswers {
  readonly model_id: string
}

// SetupPlan holds every connection and the default coordinate confirmed by the guided flow.
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
    readonly driver?: string | undefined
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
  const found = modelsDevCatalogOf(await response.json(), revision).find((entry) => entry.id === provider)
  return {
    revision,
    status: "fresh",
    env: found?.env ?? [],
    models: found?.models.filter((model) => agentModelIsSelectable({
      outputModalities: model.metadata.outputModalities?.value,
      toolCall: model.metadata.toolCall?.value
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
  const driver = preset.driver ?? (yield* Prompt.select<ModelDriver>({
    message: "Which protocol does this endpoint accept?",
    choices: MODEL_DRIVERS.map((driver) => ({ title: driver, value: driver }))
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
      driver,
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

// setupDefaultPrompt chooses a model coordinate from configured provider connections.
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
  const allowed = new Set(["baseUrl", "driver", "env", "region"])
  const unknown = Object.keys(config).filter((name) => !allowed.has(name))
  if (unknown.length > 0) throw new Error(`provider config contains unknown ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}`)
  const preset = PRESETS.find((candidate) => candidate.provider === provider)
  const statedDriver = providerString(config, "driver")
  if (statedDriver !== undefined && !MODEL_DRIVERS.some((candidate) => candidate === statedDriver)) {
    throw new Error(`provider config driver must be one of ${MODEL_DRIVERS.join(", ")}, got ${JSON.stringify(statedDriver)}`)
  }
  if (preset?.driver !== undefined && statedDriver !== undefined && statedDriver !== preset.driver) {
    throw new Error(`provider ${JSON.stringify(provider)} uses driver ${JSON.stringify(preset.driver)}`)
  }
  const driver = preset?.driver ?? (statedDriver as ModelDriver | undefined)
  if (driver === undefined) throw new Error(`provider ${JSON.stringify(provider)} must declare driver`)
  const baseUrl = providerString(config, "baseUrl") ?? preset?.baseUrl
  if (baseUrl === undefined) throw new Error(`provider ${JSON.stringify(provider)} must declare baseUrl`)
  const region = providerString(config, "region")
  if (driver === "bedrock-converse" && region === undefined) {
    throw new Error(`provider ${JSON.stringify(provider)} must declare region for driver ${JSON.stringify(driver)}`)
  }
  if (driver !== "bedrock-converse" && region !== undefined) {
    throw new Error(`provider ${JSON.stringify(provider)} cannot declare region with driver ${JSON.stringify(driver)}`)
  }
  return {
    provider,
    baseUrl,
    driver,
    env: providerEnv(config),
    ...(region === undefined ? {} : { region })
  }
}

// defaultModelFrom resolves one declarative default coordinate without changing its provider connection.
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
    next = applyEdits(next, modify(next, ["models", "providers", provider.provider], {
      baseUrl: provider.baseUrl,
      driver: provider.driver,
      env: provider.env,
      ...(provider.region === undefined ? {} : { region: provider.region })
    }, { formattingOptions }))
  }
  if (selected !== undefined) {
    next = applyEdits(next, modify(next, ["models", "default"], selected, { formattingOptions }))
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
    `wire  ${answers.driver}`,
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
    `wire  ${provider.driver}`,
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
  readonly driver: ModelDriver
  readonly credential: "environment" | "stored"
  readonly env: ReadonlyArray<string>
  readonly region?: string
} => ({
  configPath: files.configPath,
  ...(answers.credential === undefined ? {} : { secretsPath: files.secretsPath }),
  provider: answers.provider,
  baseUrl: answers.baseUrl,
  model_id: answers.model_id,
  driver: answers.driver,
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
    driver: provider.driver,
    credential: provider.credential === undefined ? "environment" as const : "stored" as const,
    env: provider.env,
    ...(provider.region === undefined ? {} : { region: provider.region })
  }))
})

export const defaultSetupJson = (files: SetupFiles, selected: NonNullable<ModelConfig["default"]>) => ({
  configPath: files.configPath,
  default: selected
})
