import { Console, Data, Effect, Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FileSystem } from "effect/FileSystem"
import { Prompt } from "effect/unstable/cli"
import { MODEL_DRIVERS, type ModelDriver } from "@clavia/tardigrade-model/directory"
import { modelConfigOf, type Env, type ModelConfig } from "@clavia/tardigrade-server/config"
import {
  DEFAULT_MODEL_CATALOG_URL,
  modelsDevCatalogOf
} from "@clavia/tardigrade-model/metadata"

// `tdg setup` asks for a provider connection and default model, then writes the project's
// environment so the first command a person runs makes every later command work.
//
// The credential is written and never shown. It is not in the printed summary, not in `--json`, and not in
// any failure this module raises: a person who ran the command in a shared terminal, a screen
// share, or CI has no line to scrub afterwards (setup.test.ts, "the key is never echoed").

// CONFIG_MODE leaves the environment file readable and writable by its owner alone.
export const CONFIG_MODE = 0o600
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
    description: "Bedrock's own protocol. The base URL is your region's runtime endpoint",
    provider: "amazon-bedrock",
    driver: "bedrock-converse",
    credential: "AI Gateway API key"
  },
  {
    title: "Other",
    description: "A model endpoint whose protocol you declare"
  }
]

// SetupAnswers is one private provider connection and the model selected as the host default.
export interface SetupAnswers {
  readonly provider: string
  readonly baseUrl: string
  readonly model_id: string
  readonly credential: string
  readonly driver: ModelDriver
  readonly env: ReadonlyArray<string>
}

const nonEmpty = (what: string) => (value: string): Effect.Effect<string, string> =>
  value.trim().length === 0 ? Effect.fail(`${what} cannot be empty`) : Effect.succeed(value.trim())

export interface ListedModel {
  readonly id: string
  readonly name?: string
}

export interface ModelCatalogOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMillis?: number
  readonly url?: string
}

export interface SetupPromptOptions {
  readonly current?: {
    readonly provider?: string | undefined
    readonly model_id?: string | undefined
    readonly driver?: string | undefined
    readonly env?: ReadonlyArray<string> | undefined
  }
  readonly catalog?: ModelCatalogOptions
}

type ModelPick = { readonly tag: "model"; readonly model: ListedModel } | { readonly tag: "manual" }

export const modelsDevAt = async (
  provider: string,
  options: ModelCatalogOptions = {}
): Promise<{
  readonly revision: string
  readonly env: ReadonlyArray<string>
  readonly models: ReadonlyArray<ListedModel>
}> => {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_MODEL_LIST_TIMEOUT_MILLIS
  const url = options.url ?? DEFAULT_MODEL_CATALOG_URL
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMillis)
  })
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`)
  const revision = response.headers.get("etag") ?? response.headers.get("last-modified") ?? "unversioned"
  const found = modelsDevCatalogOf(await response.json(), revision).find((entry) => entry.id === provider)
  return {
    revision,
    env: found?.env ?? [],
    models: found?.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name })
    })) ?? []
  }
}

// setupPrompt is the conversation: provider, base URL, credential, then a searchable model list.
// The password prompt keeps the credential redacted, and a failed discovery request falls back to
// manual entry without blocking setup.
export const setupPrompt = (options: SetupPromptOptions = {}) => Effect.gen(function*() {
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
  const baseUrl = yield* Prompt.text({
    message: preset.provider === "amazon-bedrock" ? "Bedrock runtime endpoint" : "Base URL",
    ...(preset.baseUrl === undefined ? {} : { default: preset.baseUrl }),
    validate: nonEmpty("the base URL")
  })
  const catalogResult = yield* Effect.tryPromise(() => modelsDevAt(provider, options.catalog)).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (result) => result })
  )
  const suggestedEnv = options.current?.env?.[0] ?? catalogResult?.env[0]
  const credentialEnv = yield* Prompt.text({
    message: "Credential environment variable",
    ...(suggestedEnv === undefined ? {} : { default: suggestedEnv }),
    validate: nonEmpty("the credential environment variable")
  })
  const credential = yield* Prompt.password({
    message: `${preset.credential ?? "API key"} for ${credentialEnv}`,
    validate: nonEmpty("the API key")
  })
  const loaded = catalogResult?.models
  const current = options.current?.model_id?.trim()
  const catalog = preset.modelsUrl === undefined ? "" : ` · Browse ${preset.modelsUrl}`
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
      message: `Choose the default model${catalog}`,
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
  return {
    provider,
    baseUrl,
    model_id: selected.id,
    credential: Redacted.value(credential),
    driver,
    env: [credentialEnv, ...(catalogResult?.env ?? []).filter((name) => name !== credentialEnv)]
  } satisfies SetupAnswers
})

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

class SetupConfigError extends Data.TaggedError("SetupConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

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

const modelFromEnvironment = (env: Env): ModelConfig => {
  const raw = env["TARDIGRADE_MODELS"]?.trim()
  if (raw === undefined || raw.length === 0) return { default: undefined, providers: {} }
  try {
    return modelConfigOf(JSON.parse(raw) as unknown)
  } catch (cause) {
    throw new Error(`existing TARDIGRADE_MODELS is invalid: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

// writeSetup merges one connection into the project environment and leaves the file at 0600.
export const writeSetup = (
  root: string,
  answers: SetupAnswers
): Effect.Effect<string, PlatformError | SetupConfigError, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    if (!ENV_NAME.test(answers.env[0] ?? "")) {
      return yield* new SetupConfigError({ message: `credential environment variable must match ${ENV_NAME}` })
    }
    const path = envPathIn(root)
    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
    const held = yield* Effect.try({
      try: () => modelFromEnvironment(setupEnvironmentOf(raw)),
      catch: (cause) => new SetupConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      })
    })
    const model: ModelConfig = {
      default: { provider: answers.provider, model_id: answers.model_id },
      providers: {
        ...held.providers,
        [answers.provider]: {
          baseUrl: answers.baseUrl,
          driver: answers.driver,
          env: answers.env
        }
      }
    }
    const next = withAssignments(raw, {
      TARDIGRADE_MODELS: JSON.stringify(model),
      [answers.env[0]!]: answers.credential
    })
    yield* fs.writeFileString(path, next, { mode: CONFIG_MODE })
    // The mode is set again after the write, because `mode` applies when a file is created and this
    // may have replaced one that already existed at a wider mode (setup.test.ts).
    yield* fs.chmod(path, CONFIG_MODE)
    return path
  })

export const readSetupEnv = (root: string): Effect.Effect<Env, never, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    const raw = yield* fs.readFileString(envPathIn(root)).pipe(Effect.orElseSucceed(() => ""))
    return setupEnvironmentOf(raw)
  })

// setupSummary is what the command prints. The credential is stated as stored rather than shown, and the
// same is true of the `--json` rendering, so neither output can be the place a key leaks.
export const setupSummary = (path: string, answers: SetupAnswers): string =>
  [
    `wrote ${path}`,
    `provider ${answers.provider}`,
    `at    ${answers.baseUrl}`,
    `wire  ${answers.driver}`,
    `secret ${answers.env[0]}`,
    `default ${answers.model_id}`
  ].join("\n")

export const setupJson = (path: string, answers: SetupAnswers): {
  readonly path: string
  readonly baseUrl: string
  readonly provider: string
  readonly model_id: string
  readonly driver: ModelDriver
  readonly credential: "stored"
  readonly env: ReadonlyArray<string>
} => ({
  path,
  provider: answers.provider,
  baseUrl: answers.baseUrl,
  model_id: answers.model_id,
  driver: answers.driver,
  credential: "stored",
  env: answers.env
})
