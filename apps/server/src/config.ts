import { Context, Layer } from "effect"
import {
  DEFAULT_MAX_CONCURRENT_LANES,
  driverPolicyOf
} from "@clavia/tardigrade-host/driver"
import { modelRefOf, type ModelRef } from "tardie"
import { modelProtocolOf, type ModelProtocol } from "@clavia/tardigrade-model/directory"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"

export { DEFAULT_MAX_CONCURRENT_LANES } from "@clavia/tardigrade-host/driver"

// The server combines ordinary project configuration with environment credentials and host
// settings. Every default is exported, and every resolved value is visible on ServerConfig
// (http.test.ts).

// Where the HTTP server listens when PORT is absent.
export const DEFAULT_PORT = 4242

// Where the log lives when TARDIGRADE_DB is absent: a hidden directory under the working directory.
export const DEFAULT_DB = ".tardigrade/agents.sqlite"

export const DEFAULT_ACTORS = ".tardigrade/actors"

export const DEFAULT_ACTOR_DATA = ".tardigrade/data"

// DEFAULT_PROJECT_CONFIG_PATH is the project configuration read by the direct server.
export const DEFAULT_PROJECT_CONFIG_PATH = "tardigrade.jsonc"

// DEFAULT_MODEL_CATALOG_CACHE is the last validated public snapshot used when a refresh fails.
export const DEFAULT_MODEL_CATALOG_CACHE = ".tardigrade/models.json"

// DEFAULT_MODEL_CATALOG_TIMEOUT_MILLIS bounds the source request made when the server starts.
export const DEFAULT_MODEL_CATALOG_TIMEOUT_MILLIS = 10_000

export { DEFAULT_MODEL_CATALOG_URL }

export interface ModelCatalogConfig {
  readonly sourceUrl: string
  readonly cachePath: string
  readonly timeoutMillis: number
}

// ModelProviderConfig is one private provider connection. Public model metadata belongs to the
// catalog snapshot, so changing models does not change connection configuration.
export interface ModelProviderConfig {
  readonly baseUrl: string
  readonly protocol: ModelProtocol
  readonly env: ReadonlyArray<string>
  readonly region?: string
}

// ModelConfig holds private provider connections and the reference used by the built-in actor.
export interface ModelConfig {
  readonly default: ModelRef | undefined
  readonly providers: Readonly<Record<string, ModelProviderConfig>>
}

// ProjectConfig holds ordinary configuration loaded from tardigrade.jsonc.
export interface ProjectConfig {
  readonly models: ModelConfig
}

// ModelCredentials holds environment values separately from the provider configuration that
// names them.
export type ModelCredentials = Readonly<Record<string, string>>

export interface ServerConfigValue {
  readonly port: number
  readonly db: string
  readonly actors: string
  readonly actorData: string
  readonly maxConcurrentLanes: number
  // Absent leaves the API open, which is why the process is meant to bind to localhost. Present
  // makes a bearer token required on actor routes. Process metadata stays public (http.ts).
  readonly token: string | undefined
  readonly model: ModelConfig
  readonly modelCredentials: ModelCredentials
  readonly catalog: ModelCatalogConfig
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigValue>()(
  "tardigrade/server/ServerConfig"
) {}

export type Env = Readonly<Record<string, string | undefined>>

const text = (env: Env, name: string): string | undefined => {
  const value = env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

// projectConfigPathOf resolves the visible project configuration path.
export const projectConfigPathOf = (env: Env): string =>
  text(env, "TARDIGRADE_CONFIG_PATH") ?? DEFAULT_PROJECT_CONFIG_PATH

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

const LEGACY_MODEL_ENV = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_PROVIDER",
  "MODEL_OUTPUT_GUARANTEE",
  "MODEL_OUTPUT_WITH_TOOLS"
] as const

const legacyModelError = (env: Env): Error | undefined => {
  const present = LEGACY_MODEL_ENV.filter((name) => text(env, name) !== undefined)
  if (present.length === 0) return undefined
  const provider = text(env, "MODEL_PROVIDER") ?? "<provider>"
  const model_id = text(env, "MODEL_ID") ?? "<model-id>"
  const replacement = {
    models: {
      default: { provider, model_id },
      providers: {
        [provider]: {
          baseUrl: text(env, "MODEL_BASE_URL") ?? "<base-url>",
          protocol: "<protocol>",
          env: ["<api-key-env>"]
        }
      }
    }
  }
  return new Error(
    `${present.join(", ")} ${present.length === 1 ? "is" : "are"} no longer accepted. ` +
    `Run \`tdg setup\`, or put ${JSON.stringify(replacement)} in tardigrade.jsonc. ` +
    "Replace <protocol>, set <api-key-env> as a secret environment variable, and remove the legacy variables. The legacy API key was not printed."
  )
}

// modelConfigOf validates provider connections used by a directly hosted server.
export const modelConfigOf = (value: unknown): ModelConfig => {
  const source = recordOf(value)
  if (source === undefined) throw new Error("provider connection configuration must be a JSON object")
  const unknownModelFields = Object.keys(source).filter((name) => name !== "default" && name !== "providers")
  if (unknownModelFields.length > 0) throw new Error(`models contains unknown fields: ${unknownModelFields.join(", ")}`)
  const providersSource = recordOf(source["providers"]) ?? {}
  const providers: Record<string, ModelProviderConfig> = {}
  for (const [name, rawProvider] of Object.entries(providersSource)) {
    if (name.trim().length === 0) throw new Error("a model provider name cannot be empty")
    const provider = recordOf(rawProvider)
    if (provider === undefined) throw new Error(`provider ${JSON.stringify(name)} must be an object`)
    if (provider["apiKey"] !== undefined) {
      throw new Error(`provider ${JSON.stringify(name)} cannot contain apiKey; declare its secret environment variable in env`)
    }
    const allowed = new Set(["baseUrl", "protocol", "env", "region"])
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
    providers[name] = {
      baseUrl,
      protocol: selectedProtocol,
      env,
      ...(region === undefined ? {} : { region })
    }
  }
  const selectedValue = source["default"]
  const selected = modelRefOf(selectedValue)
  if (selectedValue !== undefined && selected === undefined) throw new Error("models.default must be { provider, model_id }")
  if (selected !== undefined && providers[selected.provider] === undefined) {
    throw new Error(`models.default names unconfigured provider ${JSON.stringify(selected.provider)}`)
  }
  return {
    default: selected,
    providers
  }
}

// projectConfigOf validates the ordinary project configuration.
export const projectConfigOf = (value: unknown): ProjectConfig => {
  const source = recordOf(value)
  if (source === undefined) throw new Error("project configuration must be a JSON object")
  return { models: modelConfigOf(source["models"] ?? {}) }
}

const modelCredentialsFrom = (model: ModelConfig, env: Env): ModelCredentials => {
  const credentials: Record<string, string> = {}
  for (const provider of Object.values(model.providers)) {
    for (const name of provider.env) {
      const value = text(env, name)
      if (value !== undefined) credentials[name] = value
    }
  }
  return credentials
}

const modelFrom = (env: Env, project: ProjectConfig): ModelConfig => {
  const legacy = legacyModelError(env)
  if (legacy !== undefined) throw legacy
  return project.models
}

// A PORT that is not a number is an operator error, not a reason to fall back: silently listening
// somewhere other than where the operator asked is worse than refusing to start.
const port = (env: Env): number => {
  const raw = text(env, "PORT")
  if (raw === undefined) return DEFAULT_PORT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`)
  }
  return value
}

// maxConcurrentLanesOf validates the host-wide count used by configuration flags and environment
// resolution.
export const maxConcurrentLanesOf = (value: number): number =>
  driverPolicyOf({ maxConcurrentLanes: value }).maxConcurrentLanes

const maxConcurrentLanes = (env: Env): number => {
  const raw = text(env, "TARDIGRADE_MAX_CONCURRENT_LANES")
  if (raw === undefined) return DEFAULT_MAX_CONCURRENT_LANES
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TARDIGRADE_MAX_CONCURRENT_LANES must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return maxConcurrentLanesOf(value)
}

const modelCatalogTimeout = (env: Env): number => {
  const raw = text(env, "TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS")
  if (raw === undefined) return DEFAULT_MODEL_CATALOG_TIMEOUT_MILLIS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

// modelCatalogConfigOf resolves the source, repository path, and source timeout for every local catalog consumer.
export const modelCatalogConfigOf = (env: Env): ModelCatalogConfig => ({
  sourceUrl: text(env, "TARDIGRADE_MODEL_CATALOG_URL") ?? DEFAULT_MODEL_CATALOG_URL,
  cachePath: text(env, "TARDIGRADE_MODEL_CATALOG_CACHE") ?? DEFAULT_MODEL_CATALOG_CACHE,
  timeoutMillis: modelCatalogTimeout(env)
})

// readConfig resolves project configuration and the environment into the value the process runs on.
export const readConfig = (
  env: Env,
  project: ProjectConfig = { models: { default: undefined, providers: {} } }
): ServerConfigValue => {
  const model = modelFrom(env, project)
  return {
    port: port(env),
    db: text(env, "TARDIGRADE_DB") ?? DEFAULT_DB,
    actors: text(env, "TARDIGRADE_ACTORS") ?? DEFAULT_ACTORS,
    actorData: text(env, "TARDIGRADE_ACTOR_DATA") ?? DEFAULT_ACTOR_DATA,
    maxConcurrentLanes: maxConcurrentLanes(env),
    token: text(env, "TARDIGRADE_TOKEN"),
    model,
    modelCredentials: modelCredentialsFrom(model, env),
    catalog: modelCatalogConfigOf(env)
  }
}

// layerConfig provides a resolved configuration; layerFromEnv reads one out of an environment.
export const layerConfig = (value: ServerConfigValue): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig)(value)

export const layerFromEnv = (env: Env): Layer.Layer<ServerConfig> => layerConfig(readConfig(env))
