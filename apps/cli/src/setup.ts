import { Console, Effect, Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FileSystem } from "effect/FileSystem"
import { Prompt } from "effect/unstable/cli"
import { MODEL_DRIVERS, type ModelDriver } from "@clavia/tardigrade-model/connection"
import { discoveredModelsOf, type ModelMetadata } from "@clavia/tardigrade-model/metadata"

import { configPathIn, parseFileConfig, type Env, type FileConfig } from "./config"

// `tdg setup` asks for the endpoint coordinates and its output capability, then writes them down,
// so the first command a person runs is the one that makes every later command work. It asks; it
// never guesses, and it never reads a key out of the environment to store it.
//
// The key is written and never shown. It is not in the printed summary, not in `--json`, and not in
// any failure this module raises: a person who ran the command in a shared terminal, a screen
// share, or CI has no line to scrub afterwards (setup.test.ts, "the key is never echoed").

// CONFIG_MODE is what the file is left at: readable and writable by its owner alone. The directory
// is made at the matching 0700, because a directory anyone can list is a directory that names the
// file inside it.
export const CONFIG_MODE = 0o600
export const CONFIG_DIR_MODE = 0o700

// DEFAULT_MODEL_LIST_TIMEOUT_MILLIS bounds the optional model discovery request. A provider that
// does not answer still leaves manual entry available, and callers of modelsAt can state another
// bound.
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
  readonly modelListUrl?: string
  readonly credentialHeader?: "authorization" | "x-api-key"
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
    modelsUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
    modelListUrl: "https://api.anthropic.com/v1/models",
    credentialHeader: "x-api-key"
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
    provider: "vercel-ai-gateway",
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
    title: "Azure AI",
    description: "Azure AI's OpenAI Responses endpoint",
    provider: "azure-ai",
    driver: "openai-responses",
    modelExample: "deployment-name",
    credential: "Azure AI API key",
    modelsUrl: "https://ai.azure.com/explore/models"
  },
  {
    title: "Google Vertex AI",
    description: "Vertex AI's OpenAI-compatible endpoint",
    provider: "google-vertex-ai",
    driver: "openai-chat-completions",
    modelExample: "google/gemini-2.5-pro",
    credential: "Google access token",
    modelsUrl: "https://console.cloud.google.com/vertex-ai/model-garden"
  },
  {
    title: "Amazon Bedrock",
    description: "Bedrock's own protocol. The base URL is your region's runtime endpoint",
    provider: "bedrock",
    driver: "bedrock-converse",
    credential: "AI Gateway API key"
  },
  {
    title: "Other",
    description: "A model endpoint whose protocol you declare"
  }
]

// SetupAnswers is what the prompts collected: the values that become the file's `model` block.
// A native guarantee includes the tool combination in the type, so neither the prompt nor a
// programmatic caller can write half a capability (apps/server/src/config.ts, outputCapabilityOf).
interface SetupCoordinates {
  readonly connection: string
  readonly baseUrl: string
  readonly id: string
  readonly apiKey: string
  readonly driver: ModelDriver
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly provider?: string | undefined
}

export type SetupAnswers = SetupCoordinates &
  (
    | { readonly output: "native"; readonly outputWithTools: "true" | "false" }
    | { readonly output: "none"; readonly outputWithTools?: never }
  )

const nonEmpty = (what: string) => (value: string): Effect.Effect<string, string> =>
  value.trim().length === 0 ? Effect.fail(`${what} cannot be empty`) : Effect.succeed(value.trim())

const positiveIntegerText = (what: string) => (value: string): Effect.Effect<string, string> => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Effect.succeed(String(number)) : Effect.fail(`${what} must be a positive integer`)
}

const optionalPositiveIntegerText = (what: string) => (value: string): Effect.Effect<string, string> =>
  value.trim() === "" ? Effect.succeed("") : positiveIntegerText(what)(value)

export interface ListedModel {
  readonly id: string
  readonly name?: string
  readonly metadata?: ModelMetadata
}

export interface ModelListOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMillis?: number
  readonly url?: string
  readonly credentialHeader?: "authorization" | "x-api-key"
}

// modelListUrl is the OpenAI-compatible discovery route for a configured base URL.
export const modelListUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/models`

// listedModels reads the common OpenAI model-list shape. Unknown rows are ignored, duplicate IDs
// collapse, and the returned order is stable for the picker.
export const listedModels = (raw: unknown, url: string = "model-list"): ReadonlyArray<ListedModel> =>
  discoveredModelsOf(raw, { kind: "discovered", url }).map((model) => ({
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(Object.keys(model.metadata).length === 0 ? {} : { metadata: model.metadata })
  }))

// modelsAt asks an OpenAI-compatible endpoint for the models visible to the supplied credential.
export const modelsAt = async (
  baseUrl: string,
  apiKey: string,
  options: ModelListOptions = {}
): Promise<ReadonlyArray<ListedModel>> => {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_MODEL_LIST_TIMEOUT_MILLIS
  const url = options.url ?? modelListUrl(baseUrl)
  const credentialHeader = options.credentialHeader ?? "authorization"
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      [credentialHeader]: credentialHeader === "authorization" ? `Bearer ${apiKey}` : apiKey,
      ...(credentialHeader === "x-api-key" ? { "anthropic-version": "2023-06-01" } : {})
    },
    signal: AbortSignal.timeout(timeoutMillis)
  })
  if (!response.ok) throw new Error(`model list returned ${response.status}`)
  return listedModels(await response.json(), url)
}

export interface SetupPromptOptions {
  readonly current?: {
    readonly connection?: string | undefined
    readonly id?: string | undefined
    readonly driver?: string | undefined
    readonly contextWindowTokens?: number | undefined
    readonly maxOutputTokens?: number | undefined
  }
  readonly modelList?: ModelListOptions
}

type ModelPick = { readonly tag: "model"; readonly model: ListedModel } | { readonly tag: "manual" }

type OutputPick =
  | { readonly output: "native"; readonly outputWithTools: "true" | "false" }
  | { readonly output: "none"; readonly outputWithTools?: never }

// setupPrompt is the conversation: provider, base URL, credential, then a searchable model list.
// The password prompt keeps the credential redacted, and a failed discovery request falls back to
// manual entry without blocking setup.
export const setupPrompt = (options: SetupPromptOptions = {}) => Effect.gen(function*() {
  const preset = yield* Prompt.select({
    message: "Which model provider?",
    choices: PRESETS.map((preset) => ({ title: preset.title, value: preset, description: preset.description }))
  })
  const connection = yield* Prompt.text({
    message: "Connection name",
    default: options.current?.connection ?? preset.provider ?? preset.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    validate: nonEmpty("the connection name")
  })
  const driver = preset.driver ?? (yield* Prompt.select<ModelDriver>({
    message: "Which protocol does this endpoint accept?",
    choices: MODEL_DRIVERS.map((driver) => ({ title: driver, value: driver }))
  }))
  const baseUrl = yield* Prompt.text({
    message: preset.provider === "bedrock" ? "Bedrock runtime endpoint" : "Base URL",
    ...(preset.baseUrl === undefined ? {} : { default: preset.baseUrl }),
    validate: nonEmpty("the base URL")
  })
  const apiKey = yield* Prompt.password({
    message: preset.credential ?? "API key",
    validate: nonEmpty("the API key")
  })
  const loaded = yield* Effect.tryPromise(() => modelsAt(baseUrl, Redacted.value(apiKey), {
    ...options.modelList,
    ...(preset.modelListUrl === undefined ? {} : { url: preset.modelListUrl }),
    ...(preset.credentialHeader === undefined ? {} : { credentialHeader: preset.credentialHeader })
  })).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (models) => models })
  )
  const current = options.current?.id?.trim()
  const catalog = preset.modelsUrl === undefined ? "" : ` · Browse ${preset.modelsUrl}`
  const manual = () => Prompt.text({
    message: `${preset.modelExample === undefined ? "Model ID" : `Model ID, for example ${preset.modelExample}`}${catalog}`,
    ...(current === undefined || current.length === 0 ? {} : { default: current }),
    validate: nonEmpty("the model ID")
  })
  let selected: ListedModel
  if (loaded === undefined || loaded.length === 0) {
    yield* Console.log(`Could not load a model list from ${preset.modelListUrl ?? modelListUrl(baseUrl)}. Enter a model ID manually.`)
    selected = { id: yield* manual() }
  } else {
    const models = [...loaded]
    if (current !== undefined && current.length > 0 && !models.some((model) => model.id === current)) {
      models.unshift({ id: current, name: "Currently configured" })
    }
    const picked = yield* Prompt.autoComplete<ModelPick>({
      message: `Choose a model${catalog}`,
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
  const discoveredContext = selected.metadata?.contextWindowTokens?.value
  const contextWindowTokens = Number(yield* Prompt.text({
    message: "Context window tokens",
    ...((discoveredContext ?? options.current?.contextWindowTokens) === undefined
      ? {}
      : { default: String(discoveredContext ?? options.current?.contextWindowTokens) }),
    validate: positiveIntegerText("the context window")
  }))
  const discoveredOutput = selected.metadata?.maxOutputTokens?.value
  const maxOutput = yield* Prompt.text({
    message: "Maximum output tokens, blank when the endpoint does not declare one",
    ...((discoveredOutput ?? options.current?.maxOutputTokens) === undefined
      ? {}
      : { default: String(discoveredOutput ?? options.current?.maxOutputTokens) }),
    validate: optionalPositiveIntegerText("the maximum output")
  })
  const maxOutputTokens = maxOutput.trim() === "" ? undefined : Number(maxOutput)
  const output = yield* Prompt.select<OutputPick>({
    message: "What structured output does this endpoint and model guarantee?",
    choices: [
      {
        title: "Native, including tool calls",
        description: "The provider accepts a strict response schema beside a tool list.",
        value: { output: "native", outputWithTools: "true" }
      },
      {
        title: "Native, without tool calls",
        description: "The provider accepts a strict response schema only when the call offers no tools.",
        value: { output: "native", outputWithTools: "false" }
      },
      {
        title: "No native guarantee",
        description: "Structured turns require an explicit local, repair, or delegated fallback.",
        value: { output: "none" }
      }
    ]
  })
  return {
    connection,
    baseUrl,
    id: selected.id,
    apiKey: Redacted.value(apiKey),
    driver,
    contextWindowTokens,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(preset.provider === undefined ? {} : { provider: preset.provider }),
    ...output
  } satisfies SetupAnswers
})

// homeOf names where the file goes. A machine with no home directory is a machine this command
// cannot write to, and saying so is better than writing somewhere nobody will look again.
export const HOME_MISSING = "no home directory: HOME names where `~/.tardigrade/config.json` goes, and it is unset"

export const homeOf = (env: Env): string | undefined => {
  const home = env["HOME"]?.trim()
  return home === undefined || home.length === 0 ? undefined : home
}

// writeSetup merges the answers into whatever the file already held and writes it back at 0600. The
// merge is what keeps a `url` or a `token` a person put there by hand: this command owns the
// `model` block and nothing else (config.ts, FileConfig).
export const writeSetup = (
  home: string,
  answers: SetupAnswers
): Effect.Effect<string, PlatformError, FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    const path = configPathIn(home)
    const directory = path.slice(0, path.lastIndexOf("/"))
    const held: FileConfig = yield* fs.readFileString(path).pipe(
      Effect.map(parseFileConfig),
      Effect.orElseSucceed(() => ({}) as FileConfig)
    )
    const next: FileConfig = {
      ...held,
      model: {
        default: { id: answers.id, connection: answers.connection },
        connections: {
          ...(held.model?.connections ?? {}),
          [answers.connection]: {
            baseUrl: answers.baseUrl,
            apiKey: answers.apiKey,
            driver: answers.driver,
            ...(answers.provider === undefined ? {} : { provider: answers.provider }),
            models: {
              ...(held.model?.connections?.[answers.connection]?.models ?? {}),
              [answers.id]: {
                contextWindowTokens: answers.contextWindowTokens,
                ...(answers.maxOutputTokens === undefined ? {} : { maxOutputTokens: answers.maxOutputTokens }),
                output: answers.output,
                ...(answers.outputWithTools === undefined ? {} : { outputWithTools: answers.outputWithTools })
              }
            }
          }
        }
      }
    }
    yield* fs.makeDirectory(directory, { recursive: true, mode: CONFIG_DIR_MODE })
    yield* fs.writeFileString(path, `${JSON.stringify(next, undefined, 2)}\n`, { mode: CONFIG_MODE })
    // The mode is set again after the write, because `mode` applies when a file is created and this
    // may have replaced one that already existed at a wider mode (setup.test.ts).
    yield* fs.chmod(path, CONFIG_MODE)
    return path
  })

// setupSummary is what the command prints. The key is stated as stored rather than shown, and the
// same is true of the `--json` rendering, so neither output can be the place a key leaks.
export const setupSummary = (path: string, answers: SetupAnswers): string =>
  [
    `wrote ${path}`,
    `model ${answers.id}`,
    `via   ${answers.connection}`,
    `at    ${answers.baseUrl}${answers.provider === undefined ? "" : ` (${answers.provider})`}`,
    `wire  ${answers.driver}`,
    `input ${answers.contextWindowTokens} tokens`,
    `limit ${answers.maxOutputTokens === undefined ? "undeclared" : `${answers.maxOutputTokens} output tokens`}`,
    `output ${answers.output === "native" ? `native (${answers.outputWithTools === "true" ? "with tools" : "without tools"})` : "none"}`
  ].join("\n")

export const setupJson = (path: string, answers: SetupAnswers): {
  readonly path: string
  readonly baseUrl: string
  readonly connection: string
  readonly id: string
  readonly driver: ModelDriver
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly provider?: string
  readonly output: "native" | "none"
  readonly outputWithTools?: boolean
  readonly apiKey: "stored"
} => ({
  path,
  connection: answers.connection,
  baseUrl: answers.baseUrl,
  id: answers.id,
  driver: answers.driver,
  contextWindowTokens: answers.contextWindowTokens,
  ...(answers.maxOutputTokens === undefined ? {} : { maxOutputTokens: answers.maxOutputTokens }),
  ...(answers.provider === undefined ? {} : { provider: answers.provider }),
  output: answers.output,
  ...(answers.outputWithTools === undefined ? {} : { outputWithTools: answers.outputWithTools === "true" }),
  apiKey: "stored"
})
