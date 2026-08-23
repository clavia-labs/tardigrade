import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { DEFAULT_BASE_URL } from "@clavia/tardigrade-client"
import {
  maxConcurrentLanesOf,
  outputCapabilityOf,
  readConfig,
  type Env,
  type ServerConfigValue
} from "@clavia/tardigrade-server/config"
import { modelDriverOf, type ModelReference } from "@clavia/tardigrade-model/connection"

// Where a value comes from, decided once. Three sources in one order, everywhere: a flag stated on
// the command line, then the environment, then the file `tdg setup` wrote, then the exported
// default. The order is the whole of the rule, so a value a person can see on the command line
// always beats a value they cannot (config.test.ts).

export type { Env }

// An empty or blank variable is an absent one, matching the server's reader: an exported variable
// nobody set should not shadow a default.
const text = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

// resolve is that order, in one function. Every value the command line resolves passes through it,
// so there is no second place a precedence could be written differently.
export const resolve = (
  flag: string | undefined,
  variable: string | undefined,
  file: string | undefined
): string | undefined => text(flag) ?? text(variable) ?? text(file)

// CONFIG_RELATIVE is where the file lives under the home directory, and configPathIn joins it. The
// path is a constant rather than a string each command spells, so `tdg setup` writes what every
// other command reads (setup.ts).
export const CONFIG_RELATIVE = ".tardigrade/config.json"

export const configPathIn = (home: string): string => `${home}/${CONFIG_RELATIVE}`

// FileConfig is the file's whole shape. `model` is what `tdg setup` asks for; `url` and `token` are
// there because the resolution order is one order for every value, and a person who points every
// command at the same remote writes them once instead of exporting them per shell. The API key is
// the one value nothing ever prints back (setup.ts).
export interface FileConfig {
  readonly model?: {
    readonly default?: ModelReference
    readonly connections?: Readonly<Record<string, {
      readonly baseUrl?: string
      readonly apiKey?: string
      readonly driver?: string
      readonly provider?: string
      readonly models?: Readonly<Record<string, {
        readonly contextWindowTokens?: number
        readonly maxOutputTokens?: number
        readonly output?: string
        readonly outputWithTools?: string
      }>>
    }>>
  }
  readonly url?: string
  readonly token?: string
}

const stringField = (source: Record<string, unknown>, name: string): string | undefined => {
  const value = source[name]
  return typeof value === "string" ? value : undefined
}

const positiveIntegerField = (source: Record<string, unknown>, name: string): number | undefined => {
  const value = source[name]
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const modelReferenceField = (value: unknown): ModelReference | undefined => {
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  if (typeof value !== "object" || value === null) return undefined
  const source = value as Record<string, unknown>
  const id = stringField(source, "id")?.trim()
  const connection = stringField(source, "connection")?.trim()
  if (id === undefined || id.length === 0) return undefined
  return connection === undefined || connection.length === 0 ? { id } : { id, connection }
}

const fileModelsOf = (value: unknown): NonNullable<NonNullable<NonNullable<FileConfig["model"]>["connections"]>[string]["models"]> => {
  if (typeof value !== "object" || value === null) return {}
  const models: Record<string, NonNullable<NonNullable<NonNullable<FileConfig["model"]>["connections"]>[string]["models"]>[string]> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue
    const source = raw as Record<string, unknown>
    models[id] = {
      ...(positiveIntegerField(source, "contextWindowTokens") === undefined ? {} : { contextWindowTokens: positiveIntegerField(source, "contextWindowTokens")! }),
      ...(positiveIntegerField(source, "maxOutputTokens") === undefined ? {} : { maxOutputTokens: positiveIntegerField(source, "maxOutputTokens")! }),
      ...(stringField(source, "output") === undefined ? {} : { output: stringField(source, "output")! }),
      ...(stringField(source, "outputWithTools") === undefined ? {} : { outputWithTools: stringField(source, "outputWithTools")! })
    }
  }
  return models
}

const fileConnectionsOf = (value: unknown): NonNullable<NonNullable<FileConfig["model"]>["connections"]> => {
  if (typeof value !== "object" || value === null) return {}
  const connections: Record<string, NonNullable<NonNullable<FileConfig["model"]>["connections"]>[string]> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue
    const source = raw as Record<string, unknown>
    connections[name] = {
      ...(stringField(source, "baseUrl") === undefined ? {} : { baseUrl: stringField(source, "baseUrl")! }),
      ...(stringField(source, "apiKey") === undefined ? {} : { apiKey: stringField(source, "apiKey")! }),
      ...(stringField(source, "driver") === undefined ? {} : { driver: stringField(source, "driver")! }),
      ...(stringField(source, "provider") === undefined ? {} : { provider: stringField(source, "provider")! }),
      models: fileModelsOf(source["models"])
    }
  }
  return connections
}

// parseFileConfig reads what it recognizes and ignores the rest. A file with a key nobody declared
// is a file written by a later version of this command, and refusing to run over it would strand a
// person on a machine they cannot configure.
export const parseFileConfig = (raw: string): FileConfig => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null) return {}
  const source = parsed as Record<string, unknown>
  const model = typeof source["model"] === "object" && source["model"] !== null
    ? (source["model"] as Record<string, unknown>)
    : {}
  return {
    model: {
      ...(modelReferenceField(model["default"]) === undefined ? {} : { default: modelReferenceField(model["default"])! }),
      connections: fileConnectionsOf(model["connections"])
    },
    ...(stringField(source, "url") === undefined ? {} : { url: stringField(source, "url")! }),
    ...(stringField(source, "token") === undefined ? {} : { token: stringField(source, "token")! })
  }
}

// readFileConfig answers the file's contents, or an empty configuration. A missing file, an
// unreadable one, and a malformed one are all the same answer: the file is the third source, and a
// command whose flags and environment already say enough must still run (config.test.ts).
export const readFileConfig = (env: Env): Effect.Effect<FileConfig, never, FileSystem> =>
  Effect.gen(function*() {
    const home = text(env["HOME"])
    if (home === undefined) return {}
    const fs = yield* FileSystem
    const raw = yield* fs.readFileString(configPathIn(home)).pipe(Effect.orElseSucceed(() => undefined))
    return raw === undefined ? {} : parseFileConfig(raw)
  })

// What a command that talks to a server over HTTP resolves to.
export interface Remote {
  readonly baseUrl: string
  readonly token: string | undefined
}

export interface RemoteFlags {
  readonly url?: string | undefined
  readonly token?: string | undefined
}

// resolveRemote answers where to call and what to present. The base URL falls back to the client's
// own default rather than to anything derived from PORT: PORT says where a server this machine
// starts listens, and a command may be pointed at a server on another machine, so the two are
// stated separately (config.test.ts, "a flag beats the environment").
export const resolveRemote = (flags: RemoteFlags, env: Env, file: FileConfig = {}): Remote => ({
  baseUrl: resolve(flags.url, undefined, file.url) ?? DEFAULT_BASE_URL,
  token: resolve(flags.token, env["TARDIGRADE_TOKEN"], file.token)
})

export interface ServerFlags {
  readonly port?: number | undefined
  readonly db?: string | undefined
  readonly actors?: string | undefined
  readonly actorData?: string | undefined
  readonly maxConcurrentLanes?: number | undefined
}

// resolveServer answers what `tdg dev` boots on. It starts from the server's own reader, so a
// variable the server honours is a variable this command honours and the two can never disagree,
// and then lets the file fill what the environment left absent and a flag win over both. A PORT
// that is not a port still refuses to resolve, because the reader is the server's
// (apps/server/src/config.ts, readConfig).
//
// The token is dropped, `TARDIGRADE_TOKEN` in the environment included. `tdg dev` is the local
// command: it binds loopback (dev.ts, DEV_HOST) and what keeps it private is the interface rather
// than a secret. A server meant to be reachable by anyone else is the server run directly with a
// token set (docs/how-to/server.md; config.test.ts, "the token is dropped, so the local server is
// ungated").
export const resolveServer = (flags: ServerFlags, env: Env, file: FileConfig = {}): ServerConfigValue => {
  const base = readConfig(env)
  const model = file.model ?? {}
  const fileConnections = Object.fromEntries(Object.entries(model.connections ?? {}).map(([name, connection]) => [
    name,
    {
      baseUrl: text(connection.baseUrl),
      apiKey: text(connection.apiKey),
      driver: text(connection.driver) === undefined ? undefined : modelDriverOf(text(connection.driver)!),
      provider: text(connection.provider),
      models: Object.fromEntries(Object.entries(connection.models ?? {}).map(([id, metadata]) => [
        id,
        {
          contextWindowTokens: metadata.contextWindowTokens,
          maxOutputTokens: metadata.maxOutputTokens,
          output: outputCapabilityOf(text(metadata.output), text(metadata.outputWithTools))
        }
      ]))
    }
  ]))
  return {
    ...base,
    port: flags.port ?? base.port,
    db: text(flags.db) ?? base.db,
    actors: text(flags.actors) ?? base.actors,
    actorData: text(flags.actorData) ?? base.actorData,
    maxConcurrentLanes: maxConcurrentLanesOf(flags.maxConcurrentLanes ?? base.maxConcurrentLanes),
    token: undefined,
    model: {
      default: base.model.default ?? model.default,
      connections: { ...fileConnections, ...base.model.connections }
    }
  }
}
