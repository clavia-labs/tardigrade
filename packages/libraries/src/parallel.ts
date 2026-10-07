import { Effect, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { type Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { defineLibrary, MethodDescription, MethodHints } from "./library"
import { type LibraryFetch } from "./types"

export const DEFAULT_PARALLEL_ENDPOINT = "https://search.parallel.ai/mcp"
export const DEFAULT_PARALLEL_USER_AGENT = "tardigrade (Parallel Search MCP)"
export const DEFAULT_PARALLEL_TIMEOUT_MS = 60_000
const Queries = Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
const SessionId = Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(100)))
const HttpUrl = Schema.String.check(Schema.isPattern(/^https?:\/\//))

// parallel exposes anonymous Parallel Search MCP tools through the library adapter (packages/platform/test/bun/parallel.test.ts).
export function parallel(options: {
  readonly fetch?: LibraryFetch
  readonly endpoint?: string
  readonly userAgent?: string
  readonly timeoutMs?: number
} = {}) {
  const endpoint = new URL(options.endpoint ?? DEFAULT_PARALLEL_ENDPOINT)
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("Parallel endpoint must use HTTP or HTTPS")
  const timeoutMs = options.timeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Parallel timeoutMs must be a positive safe integer")
  const userAgent = options.userAgent ?? DEFAULT_PARALLEL_USER_AGENT
  if (!userAgent.trim()) throw new Error("Parallel userAgent must be nonempty")
  const requestFetch = options.fetch ?? globalThis.fetch
  const library = defineLibrary({ name: "parallel", description: "Search the web and extract pages using anonymous Parallel Search MCP. Free-tier rate limits apply.", methods: [
    Rpc.make("search", {
      payload: Schema.Struct({ objective: Schema.NonEmptyString, search_queries: Queries, session_id: SessionId }),
      success: Schema.Json, error: Schema.String,
    }).annotate(MethodDescription, `Search for a focused objective with related keyword queries. Returns MCP content with source URLs and excerpts. The complete call has a ${timeoutMs}ms timeout.`)
      .annotate(MethodHints, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    Rpc.make("fetch", {
      payload: Schema.Struct({
        session_id: SessionId, urls: Schema.Array(HttpUrl).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
        objective: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        search_queries: Schema.optionalKey(Queries), full_content: Schema.optionalKey(Schema.Boolean),
      }),
      success: Schema.Json, error: Schema.String,
    }).annotate(MethodDescription, `Extract excerpts from HTTP or HTTPS URLs. Set full_content to true for complete markdown; large pages can exceed the server output limit. Returns MCP content. The complete call has a ${timeoutMs}ms timeout.`)
      .annotate(MethodHints, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  ] })
  const invoke = (name: string, args: Record<string, unknown>) => Effect.tryPromise({
    try: async signal => {
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      ])
      const client = new Client({ name: "tardigrade", version: "0.44.0" })
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { "User-Agent": userAgent } },
        fetch: (url, init) => requestFetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }),
      })
      try {
        // The SDK concrete transport allows undefined optional fields; its Transport interface omits undefined under exactOptionalPropertyTypes.
        await client.connect(transport as Transport, { signal, timeout: timeoutMs })
        const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs })
        if (result.isError) throw new Error(JSON.stringify(result.content))
        return result
      } finally { await client.close() }
    }, catch: String,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.timeout(timeoutMs), Effect.mapError(String))
  return library.implement({ search: args => invoke("web_search", args), fetch: args => invoke("web_fetch", args) })
}
