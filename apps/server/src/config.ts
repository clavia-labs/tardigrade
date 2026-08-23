import { Context, Layer } from "effect"
import {
  DEFAULT_MAX_CONCURRENT_LANES,
  driverPolicyOf
} from "@clavia/tardigrade-host/driver"

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

// The model binding's coordinates. Absent values are absent rather than guessed: the model layer
// decides what it can do without them, and the server does not invent an endpoint.
export interface ModelConfig {
  readonly baseUrl: string | undefined
  readonly apiKey: string | undefined
  readonly id: string | undefined
  readonly provider: string | undefined
  // What this endpoint and this model promise about a turn's declared output contract. A
  // provider name proves nothing here: structured output is a property of the endpoint AND the
  // model behind it, so an operator states it. Absent, a turn that declares a contract fails
  // before it spends (platform/model/src/output.ts, capabilityOf).
  readonly output: OutputCapabilityValue | undefined
}

export const OUTPUT_GUARANTEES = ["native", "none"] as const

export type OutputGuarantee = (typeof OUTPUT_GUARANTEES)[number]

// OutputCapabilityValue is the whole capability, so nothing about it is a default this process
// chose. `withTools` says whether the schema may ride the same call as a tool list, which an
// operator must state alongside a native guarantee rather than inherit.
export type OutputCapabilityValue =
  | { readonly guarantee: "none" }
  | { readonly guarantee: "native"; readonly withTools: boolean }

export interface ServerConfigValue {
  readonly port: number
  readonly db: string
  readonly actors: string
  readonly actorData: string
  readonly maxConcurrentLanes: number
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

// MODEL_OUTPUT_GUARANTEE and MODEL_OUTPUT_WITH_TOOLS name a promise the process must be able to
// keep, so a value nobody declared is an operator error rather than a reason to guess one. A
// native guarantee has to say whether it survives beside a tool list, because a turn that offers
// tools and declares a contract sends both on one call (platform/model/src/output.ts).
export const outputCapabilityOf = (
  guarantee: string | undefined,
  withTools: string | undefined
): OutputCapabilityValue | undefined => {
  if (guarantee === undefined) {
    if (withTools !== undefined) {
      throw new Error("the model output capability states a tool combination with no guarantee; set the guarantee too")
    }
    return undefined
  }
  if (!(OUTPUT_GUARANTEES as ReadonlyArray<string>).includes(guarantee)) {
    throw new Error(`the model output guarantee must be one of ${OUTPUT_GUARANTEES.join(", ")}, got ${JSON.stringify(guarantee)}`)
  }
  if (guarantee === "none") return { guarantee: "none" }
  if (withTools === "true") return { guarantee: "native", withTools: true }
  if (withTools === "false") return { guarantee: "native", withTools: false }
  throw new Error(
    `a native model output guarantee must state whether it survives beside a tool list: set the tool combination to true or false, got ${JSON.stringify(withTools)}`
  )
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

// readConfig resolves the environment into the value the process runs on.
export const readConfig = (env: Env): ServerConfigValue => ({
  port: port(env),
  db: text(env, "TARDIGRADE_DB") ?? DEFAULT_DB,
  actors: text(env, "TARDIGRADE_ACTORS") ?? DEFAULT_ACTORS,
  actorData: text(env, "TARDIGRADE_ACTOR_DATA") ?? DEFAULT_ACTOR_DATA,
  maxConcurrentLanes: maxConcurrentLanes(env),
  token: text(env, "TARDIGRADE_TOKEN"),
  model: {
    baseUrl: text(env, "MODEL_BASE_URL"),
    apiKey: text(env, "MODEL_API_KEY"),
    id: text(env, "MODEL_ID"),
    provider: text(env, "MODEL_PROVIDER"),
    output: outputCapabilityOf(text(env, "MODEL_OUTPUT_GUARANTEE"), text(env, "MODEL_OUTPUT_WITH_TOOLS"))
  }
})

// layerConfig provides a resolved configuration; layerFromEnv reads one out of an environment.
export const layerConfig = (value: ServerConfigValue): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig)(value)

export const layerFromEnv = (env: Env): Layer.Layer<ServerConfig> => layerConfig(readConfig(env))
