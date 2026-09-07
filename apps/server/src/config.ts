import { modelConfigOf, type ModelConfig, type ModelCredentials } from "@clavia/tardigrade-model/config"
export { canonicalModelConfig, modelConfigOf, type ModelConfig, type ModelProviderConfig, type ModelCredentials } from "@clavia/tardigrade-model/config"
import { Context, Layer } from "effect"
import {
  DEFAULT_MAX_CONCURRENT_THREADS,
  driverPolicyOf
} from "@clavia/tardigrade-host/driver"
import {
  DEFAULT_MODEL_POLICY
} from "tardie"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"

export { DEFAULT_MAX_CONCURRENT_THREADS } from "@clavia/tardigrade-host/driver"

// The server combines ordinary project configuration with environment credentials and host
// settings. Every default is exported, and every resolved value is visible on ServerConfig
// (http.test.ts).

// Where the HTTP server listens when PORT is absent.
export const DEFAULT_PORT = 4242

// Where the log lives when TARDIGRADE_DB is absent: a hidden directory under the working directory.
export const DEFAULT_DB = ".tardigrade/actor.sqlite"

export const DEFAULT_ACTORS = ".tardigrade/actors"

export const DEFAULT_ACTOR_DATA = ".tardigrade/data"

// DEFAULT_PROJECT_CONFIG_PATH is the project configuration read by the direct server.
export const DEFAULT_PROJECT_CONFIG_PATH = "wrangler.jsonc"

// TARDIGRADE_CONFIG_VAR names the structured Wrangler variable that carries Tardigrade settings.
export const TARDIGRADE_CONFIG_VAR = "TARDIGRADE_CONFIG"

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
// ProjectConfig holds Tardigrade configuration loaded from the Wrangler manifest.
export interface ProjectConfig {
  readonly models: ModelConfig
}


export interface ServerConfigValue {
  readonly port: number
  readonly db: string
  readonly actors: string
  readonly actorData: string
  readonly maxConcurrentThreads: number
  // Absent leaves the API open, which is why the process is meant to bind to localhost. Present
  // makes a bearer token required on runtime and control routes. Health, API documents, and model catalog routes stay public (http.ts).
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
    vars: {
      [TARDIGRADE_CONFIG_VAR]: {
        models: {
          default: { provider, model_id },
          allow: "*",
          providers: {
            [provider]: {
              baseUrl: text(env, "MODEL_BASE_URL") ?? "<base-url>",
              protocol: "<protocol>",
              env: ["<api-key-env>"]
            }
          }
        }
      }
    }
  }
  return new Error(
    `${present.join(", ")} ${present.length === 1 ? "is" : "are"} no longer accepted. ` +
    `Run \`tdg setup\`, or put ${JSON.stringify(replacement)} in wrangler.jsonc. ` +
    "Replace <protocol>, set <api-key-env> as a secret environment variable, and remove the legacy variables. The legacy API key was not printed."
  )
}

// projectConfigOf reads runnable Tardigrade settings from a Wrangler manifest.
export const projectConfigOf = (value: unknown): ProjectConfig => {
  const source = recordOf(value)
  if (source === undefined) throw new Error("project configuration must be a JSON object")
  if (source["models"] !== undefined) {
    throw new Error(`models must be nested under vars.${TARDIGRADE_CONFIG_VAR}`)
  }
  const varsValue = source["vars"]
  if (varsValue === undefined) return { models: modelConfigOf(DEFAULT_MODEL_POLICY) }
  const vars = recordOf(varsValue)
  if (vars === undefined) throw new Error("vars must be a JSON object")
  const configValue = vars[TARDIGRADE_CONFIG_VAR]
  if (configValue === undefined) return { models: modelConfigOf(DEFAULT_MODEL_POLICY) }
  const config = recordOf(configValue)
  if (config === undefined) throw new Error(`${TARDIGRADE_CONFIG_VAR} must be a JSON object`)
  return { models: modelConfigOf(config["models"] ?? DEFAULT_MODEL_POLICY) }
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

// maxConcurrentThreadsOf validates the host-wide count used by configuration flags and environment
// resolution.
export const maxConcurrentThreadsOf = (value: number): number =>
  driverPolicyOf({ maxConcurrentThreads: value }).maxConcurrentThreads

const maxConcurrentThreads = (env: Env): number => {
  const raw = text(env, "TARDIGRADE_MAX_CONCURRENT_THREADS")
  if (raw === undefined) return DEFAULT_MAX_CONCURRENT_THREADS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TARDIGRADE_MAX_CONCURRENT_THREADS must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return maxConcurrentThreadsOf(value)
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
  project: ProjectConfig = { models: { allow: "*", providers: {} } }
): ServerConfigValue => {
  const model = modelFrom(env, project)
  return {
    port: port(env),
    db: text(env, "TARDIGRADE_DB") ?? DEFAULT_DB,
    actors: text(env, "TARDIGRADE_ACTORS") ?? DEFAULT_ACTORS,
    actorData: text(env, "TARDIGRADE_ACTOR_DATA") ?? DEFAULT_ACTOR_DATA,
    maxConcurrentThreads: maxConcurrentThreads(env),
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
