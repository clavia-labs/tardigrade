import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { definePackage, type Package } from "./packages"

// The fetch package: one HTTP request, made through `HttpClient` rather than through a global
// fetch. The service is the same one the derived client speaks (packages/client), so a consumer
// that swapped the client's transport swapped this package's too, and a test binds a client that
// answers from a server it booted itself (fetch.test.ts).
//
// The package holds no credential and pins no origin: whatever the code passes as headers is what
// goes on the wire. A package that speaks to a credentialed provider is the other shape, a
// `Connection` and its door (packages/code/src/packages.ts), and this one is the open one.

// FetchPolicy bounds what one answer can put in a turn's context. `bodyChars` is where the body is
// cut; the answer says `truncated` when it was, so a model reading a cut body knows it read a
// prefix. The cap bounds what the turn reads rather than what the network carried: the response is
// received whole and cut before it becomes an answer.
export interface FetchPolicy {
  readonly bodyChars: number
}

export const DEFAULT_FETCH_BODY_CHARS = 65_536

export const DEFAULT_FETCH_POLICY: FetchPolicy = { bodyChars: DEFAULT_FETCH_BODY_CHARS }

export const fetchPolicyOf = (policy: Partial<FetchPolicy> = {}): FetchPolicy => ({
  bodyChars: policy.bodyChars ?? DEFAULT_FETCH_POLICY.bodyChars
})

// The methods the model is offered. A GET is safe by the HTTP specification's own word, so it is
// annotated read-only and a shadow run may make one; `request` carries whatever method the code
// names, so it reads as the most dangerous thing it could be. The two share one implementation:
// the annotation is the only difference, and it is the honest one.
export interface FetchOptions {
  readonly policy?: Partial<FetchPolicy>
}

interface Answer {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly truncated?: boolean
  readonly error?: string
}

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const
type Method = (typeof METHODS)[number]

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const send = (
  policy: FetchPolicy,
  method: Method,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string | undefined
): Effect.Effect<Answer, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders(headers),
      (built) => (body === undefined ? built : HttpClientRequest.bodyText(built, body))
    )
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(request)
      const text = yield* response.text
      const cut = text.slice(0, policy.bodyChars)
      return {
        status: response.status,
        headers: { ...response.headers },
        body: cut,
        ...(cut.length < text.length ? { truncated: true } : {})
      }
      // A transport failure is an answer the model reads, never a failed effect: a host that is
      // down is information the code can act on, and a `Park` is reserved for a reply that has not
      // landed yet (packages/code/src/errors.ts).
    }).pipe(Effect.catch((error) => Effect.succeed({ error: `${method} ${url}: ${failure(error)}` })))
  })

const methodOf = (raw: unknown): Method | undefined => {
  const upper = String(raw ?? "").toUpperCase()
  return METHODS.find((method) => method === upper)
}

const headersOf = (raw: unknown): Readonly<Record<string, string>> => {
  if (typeof raw !== "object" || raw === null) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value
  }
  return out
}

// fetchPackage builds the package. `Package<HttpClient>` is what its methods need, so an assembly
// that mounts it cannot run on a host that binds no client (packages/code/src/execute.ts,
// codeReactorFor).
export const fetchPackage = (options: FetchOptions = {}): Package<HttpClient.HttpClient> => {
  const policy = fetchPolicyOf(options.policy)
  const answer = {
    type: "object",
    properties: {
      status: { type: "number" },
      headers: { type: "object" },
      body: { type: "string" },
      truncated: { type: "boolean" },
      error: { type: "string" }
    }
  }
  return definePackage({
    name: "fetch",
    description:
      "HTTP requests to any host. fetch.get reads a URL; fetch.request sends any method with headers and a body. The answer carries the status, the response headers, and the body as text.",
    annotations: {
      get: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      // The method rides the arguments, so this one may be a DELETE. It claims nothing it cannot
      // guarantee and reads as the most dangerous thing it could be (packages.ts,
      // ANNOTATION_DEFAULTS).
      request: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    docs: {
      get: {
        description: `GET one URL. The body comes back as text, cut at ${policy.bodyChars} characters, and the answer says truncated when it was cut. A transport failure is an \`error\` rather than a throw.`,
        input: {
          type: "object",
          properties: { url: { type: "string" }, headers: { type: "object" } },
          required: ["url"]
        },
        output: answer
      },
      request: {
        description: `Send one HTTP request. method is one of ${METHODS.join(", ")}. The body comes back as text, cut at ${policy.bodyChars} characters, and the answer says truncated when it was cut. A transport failure is an \`error\` rather than a throw.`,
        input: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            headers: { type: "object" },
            body: { type: "string" }
          },
          required: ["method", "url"]
        },
        output: answer
      }
    },
    methods: {
      get: (args: unknown) =>
        Effect.suspend(() => {
          const a = args as { url?: string; headers?: unknown } | undefined
          if (!a?.url) return Effect.succeed({ error: "fetch.get needs { url }" })
          return send(policy, "GET", a.url, headersOf(a.headers), undefined)
        }),
      request: (args: unknown) =>
        Effect.suspend(() => {
          const a = args as { method?: string; url?: string; headers?: unknown; body?: unknown } | undefined
          if (!a?.url) return Effect.succeed({ error: "fetch.request needs { url }" })
          const method = methodOf(a.method)
          if (method === undefined) {
            return Effect.succeed({ error: `fetch.request needs { method } as one of ${METHODS.join(", ")}` })
          }
          const body = typeof a.body === "string" ? a.body : undefined
          return send(policy, method, a.url, headersOf(a.headers), body)
        })
    }
  })
}
