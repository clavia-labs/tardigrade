import { Console, Effect, Redacted } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Prompt } from "effect/unstable/cli"

import { configPathIn, parseFileConfig, type Env, type FileConfig } from "./config"

// `tdg setup` asks for the three things a turn cannot run without and writes them down, so the
// first command a person runs is the one that makes every later command work. It asks; it never
// guesses, and it never reads a key out of the environment to store it.
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
// editable; an absent one asks with no default. `provider` names the endpoint, which selects a
// protocol other than the OpenAI-compatible one the model binding speaks by default and says
// what the endpoint promises about a declared output contract (platform/model/src/model.ts,
// platform/model/src/output.ts).
//
// The list is short on purpose. Every URL here is a promise to keep it correct, so an endpoint this
// repository does not track belongs behind "Other" rather than in the list.
export interface Preset {
  readonly title: string
  readonly description: string
  readonly baseUrl?: string
  readonly provider?: string
  readonly modelExample?: string
  readonly credential?: string
  readonly modelsUrl?: string
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    title: "OpenAI",
    description: "The OpenAI-compatible protocol the binding speaks by default",
    // Named, so a turn that declares an output contract is served from this endpoint's own
    // strict response format instead of refused (platform/model/src/output.ts).
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelExample: "gpt-5.2",
    credential: "OpenAI API key",
    modelsUrl: "https://platform.openai.com/docs/models"
  },
  {
    title: "OpenRouter",
    description: "One key across many providers, over the same protocol",
    baseUrl: "https://openrouter.ai/api/v1",
    modelExample: "anthropic/claude-sonnet-latest",
    credential: "OpenRouter API key",
    modelsUrl: "https://openrouter.ai/models"
  },
  {
    title: "Vercel AI Gateway",
    description: "One Vercel key across providers, over the OpenAI-compatible protocol",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    modelExample: "anthropic/claude-opus-5",
    credential: "Vercel AI Gateway API key",
    modelsUrl: "https://vercel.com/ai-gateway/models"
  },
  {
    title: "Cloudflare AI Gateway",
    description: "Cloudflare's account-scoped OpenAI-compatible endpoint",
    modelExample: "openai/gpt-4.1",
    credential: "Cloudflare API token",
    modelsUrl: "https://developers.cloudflare.com/ai-gateway/models/"
  },
  {
    title: "Amazon Bedrock",
    description: "Bedrock's own protocol. The base URL is your region's runtime endpoint",
    provider: "bedrock",
    credential: "AI Gateway API key"
  },
  {
    title: "Other",
    description: "Any other OpenAI-compatible endpoint, including one you run yourself"
  }
]

// SetupAnswers is what the prompts collected: the values that become the file's `model` block.
export interface SetupAnswers {
  readonly baseUrl: string
  readonly id: string
  readonly apiKey: string
  readonly provider?: string | undefined
}

const nonEmpty = (what: string) => (value: string): Effect.Effect<string, string> =>
  value.trim().length === 0 ? Effect.fail(`${what} cannot be empty`) : Effect.succeed(value.trim())

export interface ListedModel {
  readonly id: string
  readonly name?: string
}

export interface ModelListOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMillis?: number
}

// modelListUrl is the OpenAI-compatible discovery route for a configured base URL.
export const modelListUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/models`

// listedModels reads the common OpenAI model-list shape. Unknown rows are ignored, duplicate IDs
// collapse, and the returned order is stable for the picker.
export const listedModels = (raw: unknown): ReadonlyArray<ListedModel> => {
  if (typeof raw !== "object" || raw === null) return []
  const source = raw as Record<string, unknown>
  const rows = Array.isArray(source["data"]) ? source["data"] : Array.isArray(source["models"]) ? source["models"] : []
  const found = new Map<string, ListedModel>()
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim()
      if (id.length > 0) found.set(id, { id })
      continue
    }
    if (typeof row !== "object" || row === null) continue
    const value = row as Record<string, unknown>
    if (typeof value["id"] !== "string" || value["id"].trim().length === 0) continue
    const id = value["id"].trim()
    const name = typeof value["name"] === "string" && value["name"].trim().length > 0 ? value["name"].trim() : undefined
    found.set(id, name === undefined ? { id } : { id, name })
  }
  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id))
}

// modelsAt asks an OpenAI-compatible endpoint for the models visible to the supplied credential.
export const modelsAt = async (
  baseUrl: string,
  apiKey: string,
  options: ModelListOptions = {}
): Promise<ReadonlyArray<ListedModel>> => {
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_MODEL_LIST_TIMEOUT_MILLIS
  const response = await fetcher(modelListUrl(baseUrl), {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMillis)
  })
  if (!response.ok) throw new Error(`model list returned ${response.status}`)
  return listedModels(await response.json())
}

export interface SetupPromptOptions {
  readonly current?: { readonly id?: string | undefined }
  readonly modelList?: ModelListOptions
}

type ModelPick = { readonly tag: "model"; readonly id: string } | { readonly tag: "manual" }

// setupPrompt is the conversation: provider, base URL, credential, then a searchable model list.
// The password prompt keeps the credential redacted, and a failed discovery request falls back to
// manual entry without blocking setup.
export const setupPrompt = (options: SetupPromptOptions = {}) => Effect.gen(function*() {
  const preset = yield* Prompt.select({
    message: "Which model provider?",
    choices: PRESETS.map((preset) => ({ title: preset.title, value: preset, description: preset.description }))
  })
  const baseUrl = yield* Prompt.text({
    message: preset.provider === "bedrock" ? "Bedrock runtime endpoint" : "Base URL",
    ...(preset.baseUrl === undefined ? {} : { default: preset.baseUrl }),
    validate: nonEmpty("the base URL")
  })
  const apiKey = yield* Prompt.password({
    message: preset.credential ?? "API key",
    validate: nonEmpty("the API key")
  })
  const loaded = yield* Effect.tryPromise(() => modelsAt(baseUrl, Redacted.value(apiKey), options.modelList)).pipe(
    Effect.match({ onFailure: () => undefined, onSuccess: (models) => models })
  )
  const current = options.current?.id?.trim()
  const catalog = preset.modelsUrl === undefined ? "" : ` · Browse ${preset.modelsUrl}`
  const manual = () => Prompt.text({
    message: `${preset.modelExample === undefined ? "Model ID" : `Model ID, for example ${preset.modelExample}`}${catalog}`,
    ...(current === undefined || current.length === 0 ? {} : { default: current }),
    validate: nonEmpty("the model ID")
  })
  let id: string
  if (loaded === undefined || loaded.length === 0) {
    yield* Console.log(`Could not load a model list from ${modelListUrl(baseUrl)}. Enter a model ID manually.`)
    id = yield* manual()
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
          value: { tag: "model", id: model.id } as const,
          ...(model.name === undefined || model.name === model.id ? {} : { description: model.name }),
          ...(model.id === current ? { selected: true } : {})
        })),
        { title: "Enter a model ID manually", value: { tag: "manual" } as const }
      ]
    })
    id = picked.tag === "model" ? picked.id : yield* manual()
  }
  return {
    baseUrl,
    id,
    apiKey: Redacted.value(apiKey),
    ...(preset.provider === undefined ? {} : { provider: preset.provider })
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
): Effect.Effect<string, unknown, FileSystem> =>
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
        baseUrl: answers.baseUrl,
        apiKey: answers.apiKey,
        id: answers.id,
        ...(answers.provider === undefined ? {} : { provider: answers.provider })
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
    `at    ${answers.baseUrl}${answers.provider === undefined ? "" : ` (${answers.provider})`}`
  ].join("\n")

export const setupJson = (path: string, answers: SetupAnswers): {
  readonly path: string
  readonly baseUrl: string
  readonly id: string
  readonly provider?: string
  readonly apiKey: "stored"
} => ({
  path,
  baseUrl: answers.baseUrl,
  id: answers.id,
  ...(answers.provider === undefined ? {} : { provider: answers.provider }),
  apiKey: "stored"
})
