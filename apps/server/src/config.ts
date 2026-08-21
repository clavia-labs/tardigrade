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

export const DEFAULT_ACTORS = ".tardigrade/actors"

export const DEFAULT_ACTOR_DATA = ".tardigrade/data"

// The model binding's coordinates. Absent values are absent rather than guessed: the model layer
// decides what it can do without them, and the server does not invent an endpoint.
export interface ModelConfig {
  readonly baseUrl: string | undefined
  readonly apiKey: string | undefined
  readonly id: string | undefined
  readonly provider: string | undefined
  // What this endpoint promises about a turn's declared output contract, for an endpoint no
  // provider name proves. "native" says it honours a strict JSON schema on its own response
  // format; absent leaves the promise to the provider name, and an unnamed endpoint promises
  // nothing, so such a turn fails before it spends (platform/model/src/output.ts, capabilityOf).
  readonly output: OutputGuarantee | undefined
}

export const OUTPUT_GUARANTEES = ["native", "none"] as const

export type OutputGuarantee = (typeof OUTPUT_GUARANTEES)[number]

export interface ServerConfigValue {
  readonly port: number
  readonly db: string
  readonly actors: string
  readonly actorData: string
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

// MODEL_OUTPUT_GUARANTEE names a promise the process must be able to keep, so a value nobody
// declared is an operator error rather than a reason to guess one.
const outputGuarantee = (env: Env): OutputGuarantee | undefined => {
  const raw = text(env, "MODEL_OUTPUT_GUARANTEE")
  if (raw === undefined) return undefined
  if ((OUTPUT_GUARANTEES as ReadonlyArray<string>).includes(raw)) return raw as OutputGuarantee
  throw new Error(`MODEL_OUTPUT_GUARANTEE must be one of ${OUTPUT_GUARANTEES.join(", ")}, got ${JSON.stringify(raw)}`)
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
  actors: text(env, "TARDIGRADE_ACTORS") ?? DEFAULT_ACTORS,
  actorData: text(env, "TARDIGRADE_ACTOR_DATA") ?? DEFAULT_ACTOR_DATA,
  token: text(env, "TARDIGRADE_TOKEN"),
  model: {
    baseUrl: text(env, "MODEL_BASE_URL"),
    apiKey: text(env, "MODEL_API_KEY"),
    id: text(env, "MODEL_ID"),
    provider: text(env, "MODEL_PROVIDER"),
    output: outputGuarantee(env)
  }
})

// layerConfig provides a resolved configuration; layerFromEnv reads one out of an environment.
export const layerConfig = (value: ServerConfigValue): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig)(value)

export const layerFromEnv = (env: Env): Layer.Layer<ServerConfig> => layerConfig(readConfig(env))
