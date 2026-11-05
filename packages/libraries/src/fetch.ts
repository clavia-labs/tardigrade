import { ToolError } from "./errors"
import { Effect, Schema } from "effect"
import { type LibraryFetch } from "./types"
import { Rpc } from "effect/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "./library"

// fetch exposes complete HTTP response bodies through foreground calls.
export function fetch(options: { readonly fetch?: LibraryFetch } = {}) {
  const requestFetch = options.fetch ?? globalThis.fetch
  const library = defineLibrary({ name: "fetch", toolNames: { get: "fetch_url" }, description: "Read HTTP and HTTPS resources.", methods: [
    Rpc.make("get", {
      payload: Schema.Struct({ url: Schema.String }),
      success: Schema.Struct({ url: Schema.String, status: Schema.Finite, ok: Schema.Boolean, body: Schema.String }),
      error: Schema.String,
    }).annotate(MethodDescription, "GET a URL and return its complete response body.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: true }),
  ] })
  return library.implement({ get: ({ url }) => Effect.tryPromise({
    try: async signal => {
      const target = new URL(url)
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new ToolError("Expected an HTTP or HTTPS URL")
      const response = await requestFetch(target, { signal })
      const body = await response.text()
      return { url: response.url || url, status: response.status, ok: response.ok, body }
    },
    catch: error => String(ToolError.from(error)),
  }) })
}
