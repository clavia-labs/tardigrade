import { Effect, Redacted } from "effect"
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

// Preset is one entry in the provider select. `baseUrl` prefills the next prompt and stays
// editable; an absent one asks with no default. `provider` names a protocol other than the
// OpenAI-compatible one the model binding speaks by default (platform/model/src/model.ts).
//
// The list is short on purpose. Every URL here is a promise to keep it correct, so an endpoint this
// repository does not track belongs behind "Other" rather than in the list.
export interface Preset {
  readonly title: string
  readonly description: string
  readonly baseUrl?: string
  readonly provider?: string
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    title: "OpenAI",
    description: "The OpenAI-compatible protocol the binding speaks by default",
    baseUrl: "https://api.openai.com/v1"
  },
  {
    title: "OpenRouter",
    description: "One key across many providers, over the same protocol",
    baseUrl: "https://openrouter.ai/api/v1"
  },
  {
    title: "Amazon Bedrock",
    description: "Bedrock's own protocol. The base URL is your region's runtime endpoint",
    provider: "bedrock"
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

// setupPrompt is the conversation: the provider, then the base URL that provider suggested, then
// the model id, then the key. The key prompt is `Prompt.password`, so the characters never reach
// the terminal, and the value it answers with is `Redacted` until this function unwraps it to hand
// it to the writer.
export const setupPrompt = Effect.gen(function*() {
  const preset = yield* Prompt.select({
    message: "Which model provider?",
    choices: PRESETS.map((preset) => ({ title: preset.title, value: preset, description: preset.description }))
  })
  const baseUrl = yield* Prompt.text({
    message: preset.provider === "bedrock" ? "Bedrock runtime endpoint" : "Base URL",
    ...(preset.baseUrl === undefined ? {} : { default: preset.baseUrl }),
    validate: nonEmpty("the base URL")
  })
  const id = yield* Prompt.text({ message: "Model id", validate: nonEmpty("the model id") })
  const apiKey = yield* Prompt.password({ message: "API key", validate: nonEmpty("the API key") })
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
    `at    ${answers.baseUrl}${answers.provider === undefined ? "" : ` (${answers.provider})`}`,
    "key   stored, never printed"
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
