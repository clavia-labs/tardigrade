import { ToolError } from "./errors"
import { Effect, Schema } from "effect"
import { definePackage } from "./package"
import { tool } from "./tool"

// fetchPackage returns complete HTTP response bodies through synchronous tool calls.
export function fetchPackage(options: { readonly fetch?: typeof globalThis.fetch } = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const definition = {
      name: "get", description: "GET a URL and return its complete response body.",
      input: Schema.Struct({ url: Schema.String }),
      run: ({ url }: { url: string }) => Effect.tryPromise({
        try: async signal => {
          const target = new URL(url)
          if (target.protocol !== "https:" && target.protocol !== "http:") throw new ToolError("Expected an HTTP or HTTPS URL")
          const response = await fetch(target, { signal })
          const body = await response.text()
          return { url: response.url || url, status: response.status, ok: response.ok, body }
        },
        catch: ToolError.from,
      }),
  }
  const method = tool({ ...definition, metadata: { readOnly: true }, execution: "sync" })
  return definePackage({ name: "fetch", toolNames: { get: "fetch_url" }, description: "Read HTTP and HTTPS resources.", methods: [method] })
}
