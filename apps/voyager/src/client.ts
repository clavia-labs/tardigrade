import { DEFAULT_BASE_URL, makeClient, type Client } from "@clavia/tardigrade-client"

// Where the app reads the server. The calls and the wire types are the client package's, derived
// from the server's own declaration (packages/client/src/contract.ts), so the app holds no second
// idea of what an agent is. What is decided here is only what a browser decides: which server this
// tab talks to, and which token it holds.

// Where the server listens when VITE_API_URL is absent, which is the client's own default
// (packages/client/src/client.ts, DEFAULT_BASE_URL).
export const DEFAULT_API_URL = DEFAULT_BASE_URL

// The localStorage key the bearer token is pasted into. The token is the server's whole auth story
// (apps/server/src/http.ts, layerAuth), so the app stores one string and the client sends it on
// every request.
export const TOKEN_KEY = "voyager.token"

const trimSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

// The server address. A query param wins over the build's env so one build can point at another
// process without a rebuild (voyager-spec.md, "Conventions").
export const apiUrl = (): string => {
  const fromEnv = import.meta.env?.VITE_API_URL
  const configured = typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_API_URL
  if (typeof location === "undefined") return trimSlash(configured)
  const stated = new URLSearchParams(location.search).get("api")
  return trimSlash(stated !== null && stated.length > 0 ? stated : configured)
}

export const token = (): string | undefined => {
  if (typeof localStorage === "undefined") return undefined
  const stored = localStorage.getItem(TOKEN_KEY)
  return stored === null || stored.length === 0 ? undefined : stored
}

// One client for the tab. The address and the token are read at load, which is when a reader could
// have stated either: a different `api` param or a pasted token is a different page load.
export const client: Client = makeClient({ baseUrl: apiUrl(), token: token() })
