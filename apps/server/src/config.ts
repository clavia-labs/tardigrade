import { Context, Layer } from "effect"
import {
  DEFAULT_MAX_CONCURRENT_LANES,
  driverPolicyOf
} from "@clavia/tardigrade-host/driver"
import type { ModelCoordinate } from "tardie"
import { modelDriverOf, type ModelDriver } from "@clavia/tardigrade-model/directory"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"

export { DEFAULT_MAX_CONCURRENT_LANES } from "@clavia/tardigrade-host/driver"

// The server's configuration is the environment and nothing else (apps-server-spec.md,
// "Conventions"). One operator, one store, one process, so there is no config file to reconcile
// with the environment and no precedence order to remember. Every default is an exported constant
// and every value is a field on ServerConfig, so a consumer can read what the process resolved and
// a test can supply its own without touching process.env (http.test.ts).

// Where the HTTP server listens when PORT is absent.
export const DEFAULT_PORT = 4242

// Where the log lives when TARDIGRADE_DB is absent: a hidden directory under the working directory.
export const DEFAULT_DB = ".tardigrade/agents.sqlite"

export const DEFAULT_ACTORS = ".tardigrade/actors"

export const DEFAULT_ACTOR_DATA = ".tardigrade/data"

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
  readonly baseUrl: string | undefined
  readonly apiKey: string | undefined
  readonly driver: ModelDriver | undefined
}

// ModelConfig holds private provider connections and the coordinate used by the built-in actor.
export interface ModelConfig {
  readonly default: ModelCoordinate | undefined
  readonly providers: Readonly<Record<string, ModelProviderConfig>>
}

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

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const coordinateOf = (value: unknown): ModelCoordinate | undefined => {
  const source = recordOf(value)
  if (source === undefined) return undefined
  const provider = stringOf(source["provider"])
  const model_id = stringOf(source["model_id"])
  return provider === undefined || model_id === undefined ? undefined : { provider, model_id }
}

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
    default: { provider, model_id },
    providers: {
      [provider]: {
        baseUrl: text(env, "MODEL_BASE_URL") ?? "<base-url>",
        apiKey: "<api-key>",
        driver: "<protocol-driver>"
      }
    }
  }
  return new Error(
    `${present.join(", ")} ${present.length === 1 ? "is" : "are"} no longer accepted. ` +
    `Run \`tdg setup\`, or set TARDIGRADE_MODELS to ${JSON.stringify(replacement)}. ` +
    "Replace <api-key> and <protocol-driver>; the legacy API key was not printed."
  )
}

// modelConfigOf validates provider connections used by a directly hosted server.
export const modelConfigOf = (value: unknown): ModelConfig => {
  const source = recordOf(value)
  if (source === undefined) throw new Error("provider connection configuration must be a JSON object")
  const providersSource = recordOf(source["providers"]) ?? {}
  const providers: Record<string, ModelProviderConfig> = {}
  for (const [name, rawProvider] of Object.entries(providersSource)) {
    if (name.trim().length === 0) throw new Error("a model provider name cannot be empty")
    const provider = recordOf(rawProvider)
    if (provider === undefined) throw new Error(`provider ${JSON.stringify(name)} must be an object`)
    const driver = stringOf(provider["driver"])
    providers[name] = {
      baseUrl: stringOf(provider["baseUrl"]),
      apiKey: stringOf(provider["apiKey"]),
      driver: driver === undefined ? undefined : modelDriverOf(driver)
    }
  }
  const selected = coordinateOf(source["default"])
  return {
    default: selected,
    providers
  }
}

const modelsFrom = (env: Env): ModelConfig => {
  const legacy = legacyModelError(env)
  if (legacy !== undefined) throw legacy
  const raw = text(env, "TARDIGRADE_MODELS")
  if (raw === undefined) return { default: undefined, providers: {} }
  try {
    return modelConfigOf(JSON.parse(raw) as unknown)
  } catch (error) {
    throw new Error(`TARDIGRADE_MODELS is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
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

// readConfig resolves the environment into the value the process runs on.
export const readConfig = (env: Env): ServerConfigValue => {
  return {
    port: port(env),
    db: text(env, "TARDIGRADE_DB") ?? DEFAULT_DB,
    actors: text(env, "TARDIGRADE_ACTORS") ?? DEFAULT_ACTORS,
    actorData: text(env, "TARDIGRADE_ACTOR_DATA") ?? DEFAULT_ACTOR_DATA,
    maxConcurrentLanes: maxConcurrentLanes(env),
    token: text(env, "TARDIGRADE_TOKEN"),
    model: modelsFrom(env),
    catalog: {
      sourceUrl: text(env, "TARDIGRADE_MODEL_CATALOG_URL") ?? DEFAULT_MODEL_CATALOG_URL,
      cachePath: text(env, "TARDIGRADE_MODEL_CATALOG_CACHE") ?? DEFAULT_MODEL_CATALOG_CACHE,
      timeoutMillis: modelCatalogTimeout(env)
    }
  }
}

// layerConfig provides a resolved configuration; layerFromEnv reads one out of an environment.
export const layerConfig = (value: ServerConfigValue): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig)(value)

export const layerFromEnv = (env: Env): Layer.Layer<ServerConfig> => layerConfig(readConfig(env))
