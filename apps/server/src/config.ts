import { Context, Layer } from "effect"

// The server's configuration is the environment and nothing else (apps-server-spec.md,
// "Conventions"). One operator, one store, one process, so there is no config file to reconcile
// with the environment and no precedence order to remember. Every default is an exported constant
// and every value is a field on ServerConfig, so a consumer can read what the process resolved and
// a test can supply its own without touching process.env (http.test.ts).

// Where the HTTP server listens when PORT is absent.
export const DEFAULT_PORT = 4242

// Where the log lives when TARDIGRADE_DB is absent: a hidden directory under the working directory.
export const DEFAULT_DB = ".tardigrade/agents.sqlite"

// The model binding's coordinates. Absent values are absent rather than guessed: the model layer
// decides what it can do without them, and the server does not invent an endpoint.
export interface ModelConfig {
  readonly baseUrl: string | undefined
  readonly apiKey: string | undefined
  readonly id: string | undefined
  readonly provider: string | undefined
}

export interface ServerConfigValue {
  readonly port: number
  readonly db: string
  // Absent leaves the API open, which is why the process is meant to bind to localhost. Present
  // makes a bearer token required on every route except /healthz (http.ts).
  readonly token: string | undefined
  readonly model: ModelConfig
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

// readConfig resolves the environment into the value the process runs on.
export const readConfig = (env: Env): ServerConfigValue => ({
  port: port(env),
  db: text(env, "TARDIGRADE_DB") ?? DEFAULT_DB,
  token: text(env, "TARDIGRADE_TOKEN"),
  model: {
    baseUrl: text(env, "MODEL_BASE_URL"),
    apiKey: text(env, "MODEL_API_KEY"),
    id: text(env, "MODEL_ID"),
    provider: text(env, "MODEL_PROVIDER")
  }
})

// layerConfig provides a resolved configuration; layerFromEnv reads one out of an environment.
export const layerConfig = (value: ServerConfigValue): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig)(value)

export const layerFromEnv = (env: Env): Layer.Layer<ServerConfig> => layerConfig(readConfig(env))
