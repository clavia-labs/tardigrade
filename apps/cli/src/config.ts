import { DEFAULT_BASE_URL } from "@clavia/tardigrade-client"
import { readConfig, type Env, type ServerConfigValue } from "@clavia/tardigrade-server/config"

// Where a value comes from, decided once. The environment is the server's own surface (PORT,
// TARDIGRADE_DB, TARDIGRADE_TOKEN, MODEL_*), read by the server's own reader, and a flag stated on
// the command line beats it. Nothing else is consulted: there is no config file and no
// precedence order beyond those two (config.test.ts).

export type { Env }

// An empty or blank variable is an absent one, matching the server's reader: an exported variable
// nobody set should not shadow a default.
const text = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

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
export const resolveRemote = (flags: RemoteFlags, env: Env): Remote => ({
  baseUrl: text(flags.url) ?? DEFAULT_BASE_URL,
  token: text(flags.token) ?? text(env["TARDIGRADE_TOKEN"])
})

export interface ServerFlags {
  readonly port?: number | undefined
  readonly db?: string | undefined
}

// resolveServer answers what `tdg dev` boots on. It starts from the server's own reader, so a
// variable the server honours is a variable this command honours and the two can never disagree,
// and then lets a flag win. A PORT that is not a port still refuses to resolve, because the reader
// is the server's (apps/server/src/config.ts, readConfig).
//
// The token is dropped, `TARDIGRADE_TOKEN` in the environment included. `tdg dev` is the local
// command: it binds loopback (dev.ts, DEV_HOST) and what keeps it private is the interface rather
// than a secret. A server meant to be reachable by anyone else is the server run directly with a
// token set (docs/how-to/server.md; config.test.ts, "the token is dropped, so the local server is
// ungated").
export const resolveServer = (flags: ServerFlags, env: Env): ServerConfigValue => {
  const base = readConfig(env)
  return {
    ...base,
    port: flags.port ?? base.port,
    db: text(flags.db) ?? base.db,
    token: undefined
  }
}
