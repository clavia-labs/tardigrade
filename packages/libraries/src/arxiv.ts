import { Effect, Schema } from "effect"
import { type LibraryFetch } from "./types"
import { Rpc } from "effect/unstable/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "./library"

export const DEFAULT_ARXIV_ENDPOINT = "https://export.arxiv.org/api/query"
export const DEFAULT_ARXIV_POLICY = { maxResults: 5, start: 0 } as const
const PositiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Offset = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

// arxiv searches the arXiv API and returns its Atom feed with the applied pagination policy.
export function arxiv(options: { readonly fetch?: LibraryFetch; readonly endpoint?: string; readonly maxResults?: number; readonly start?: number } = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoint ?? DEFAULT_ARXIV_ENDPOINT
  const policy = { maxResults: options.maxResults ?? DEFAULT_ARXIV_POLICY.maxResults, start: options.start ?? DEFAULT_ARXIV_POLICY.start }
  Schema.decodeSync(PositiveInteger)(policy.maxResults)
  Schema.decodeSync(Offset)(policy.start)
  const library = defineLibrary({ name: "arxiv", description: "Search research papers on arXiv.", methods: [
    Rpc.make("search", {
      payload: Schema.Struct({ query: Schema.NonEmptyString, maxResults: Schema.optionalKey(PositiveInteger), start: Schema.optionalKey(Offset) }),
      success: Schema.Struct({ query: Schema.String, maxResults: PositiveInteger, start: Offset, source: Schema.String, feed: Schema.String }),
      error: Schema.String,
    }).annotate(MethodDescription, `Search using arXiv query syntax, such as all:agents or ti:transformer. Returns an Atom XML feed containing paper titles, authors, abstracts, and links. Defaults to ${policy.maxResults} results starting at ${policy.start}; override maxResults and start per call.`)
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: true }),
  ] })
  return library.implement({ search: ({ query, maxResults = policy.maxResults, start = policy.start }) => Effect.tryPromise({
    try: async signal => {
      const url = new URL(endpoint)
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("arXiv endpoint must use HTTP or HTTPS")
      url.searchParams.set("search_query", query)
      url.searchParams.set("max_results", String(maxResults))
      url.searchParams.set("start", String(start))
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`arXiv request failed: HTTP ${response.status}`)
      return { query, maxResults, start, source: url.toString(), feed: await response.text() }
    }, catch: String,
  }) })
}
