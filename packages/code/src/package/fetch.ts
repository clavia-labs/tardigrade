import { Effect, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { definePackage, type Package } from "./definition"

// The fetch package: one HTTP request, made through `HttpClient` rather than through a global
// fetch. The service is the same one the derived client speaks (packages/client), so a consumer
// that swapped the client's transport swapped this package's too, and a test binds a client that
// answers from a server it booted itself (fetch.test.ts).
//
// The package holds no credential and pins no origin: whatever the code passes as headers is what
// goes on the wire. A package that speaks to a credentialed provider is the other shape, a
// `Connection` and its door (packages/code/src/package/definition.ts), and this one is the open
// one. A host that mounts it for bodies it does not trust opts into `urlPolicy`, which pins the
// network a URL may name the way the credentialed doors pin an origin (#427).

// FetchPolicy bounds what one answer can put in a turn's context. `bodyChars` is where the body is
// cut; the answer says `truncated` when it was, so a model reading a cut body knows it read a
// prefix. The cap bounds what the turn reads rather than what the network carried: the response is
// received whole and cut before it becomes an answer. `urlPolicy` is the opt-in network
// restriction; absent, the package stays the open one it was.
export interface FetchPolicy {
  readonly bodyChars: number
  readonly urlPolicy?: FetchUrlPolicy
}

// FetchUrlPolicy is the opt-in network restriction: a URL may name a public host only. Every
// literal IPv4 or IPv6 address is refused, whichever range it sits in, which covers the private,
// loopback, and link-local ranges a prompt-injected body reaches for (fetch.test.ts, "the
// urlPolicy refuses a private address" and the refusals beside it). The loopback name localhost,
// every scheme but http and https, and every redirect are refused too, so a public host cannot
// pivot a request into a host the policy never saw.
export type FetchUrlPolicy = "public-only"

export const DEFAULT_FETCH_BODY_CHARS = 65_536

export const DEFAULT_FETCH_POLICY: FetchPolicy = { bodyChars: DEFAULT_FETCH_BODY_CHARS }

export const fetchPolicyOf = (policy: Partial<FetchPolicy> = {}): FetchPolicy => ({
  bodyChars: policy.bodyChars ?? DEFAULT_FETCH_POLICY.bodyChars,
  ...(policy.urlPolicy === undefined ? {} : { urlPolicy: policy.urlPolicy })
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

// ipv4Category names the special-use range a literal IPv4 address sits in, or undefined when the
// address is global unicast. The private, loopback, and link-local ranges are what the urlPolicy
// was filed against (#427); the rest are IANA's special-purpose registry (RFC 6890) beside them,
// and none of them is a host on the public internet.
const ipv4Category = (a: number, b: number, c: number): string | undefined => {
  if (a === 0) return "this network"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private"
  if (a === 127) return "loopback"
  if (a === 169 && b === 254) return "link-local"
  if (a === 100 && b >= 64 && b <= 127) return "shared"
  if (a === 192 && b === 0 && c === 0) return "special-purpose"
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
    return "documentation"
  }
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking"
  if (a >= 224) return "reserved"
  return undefined
}

// refusalOf names why a URL cannot leave under the urlPolicy, or undefined when it may. The host
// is read from the parsed URL, so the WHATWG parser has already canonicalized an IPv4 literal
// written any odd way (0x7f.1 arrives as 127.0.0.1, fetch.test.ts, "the urlPolicy refuses a
// loopback address") and rejected what it cannot parse. A refusal is an answer the model reads,
// never a failed effect, like a transport failure beside it.
const refusalOf = (url: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "the urlPolicy needs an absolute http or https URL"
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `the urlPolicy refuses the ${parsed.protocol} scheme`
  }
  const host = parsed.hostname.replace(/\.$/, "")
  if (host.includes(":")) return `refuses the literal IP address ${host}`
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (octets !== null) {
    return `refuses the ${ipv4Category(Number(octets[1]), Number(octets[2]), Number(octets[3])) ?? "literal IP"} address ${host}`
  }
  if (host === "localhost" || host.endsWith(".localhost")) return `refuses the loopback name ${host}`
  return undefined
}

// redirectRefused executes one request with the transport's redirect handling pinned to error,
// merged over the defaults the host set. FetchHttpClient reads its RequestInit service per
// request (effect/unstable/http/FetchHttpClient.ts), so the transport throws on a redirect instead
// of following it. A transport that surfaces the redirect anyway is caught by the status check in
// send (fetch.test.ts, "the urlPolicy refuses a redirect the transport surfaces").
const redirectRefused = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest
) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (defaults) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...Option.getOrElse(defaults, (): globalThis.RequestInit => ({})),
        redirect: "error"
      })
    )
  )

const send = (
  policy: FetchPolicy,
  method: Method,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string | undefined
): Effect.Effect<Answer, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const urlPolicy = policy.urlPolicy
    if (urlPolicy !== undefined) {
      const refusal = refusalOf(url)
      if (refusal !== undefined) return { error: `${method} ${url}: ${refusal}` }
    }
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders(headers),
      (built) => (body === undefined ? built : HttpClientRequest.bodyText(built, body))
    )
    return yield* Effect.gen(function* () {
      const response = yield* urlPolicy === undefined ? client.execute(request) : redirectRefused(client, request)
      const location = response.headers["location"]
      if (urlPolicy !== undefined && location !== undefined && response.status >= 301 && response.status <= 308) {
        return { error: `${method} ${url}: the urlPolicy refuses a redirect to ${location}` }
      }
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
      // landed yet (packages/code/src/execution/errors.ts).
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
// that mounts it cannot run on a host that binds no client (packages/code/src/execution/reactor.ts,
// codeReactorFor).
export const fetchPackage = (options: FetchOptions = {}): Package<HttpClient.HttpClient> => {
  const policy = fetchPolicyOf(options.policy)
  // The sentence the method docs gain under the urlPolicy, so the model reads the restriction in
  // the tool it is about to call rather than learning it from a refusal.
  const hostRule =
    policy.urlPolicy === undefined
      ? ""
      : " The urlPolicy is set: a URL may name a public host only, a literal IP address, a private, loopback, or link-local host, and the loopback name localhost are refused, and a redirect is refused."
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
        description: `GET one URL. The body comes back as text, cut at ${policy.bodyChars} characters, and the answer says truncated when it was cut. A transport failure is an \`error\` rather than a throw.${hostRule}`,
        input: {
          type: "object",
          properties: { url: { type: "string" }, headers: { type: "object" } },
          required: ["url"]
        },
        output: answer
      },
      request: {
        description: `Send one HTTP request. method is one of ${METHODS.join(", ")}. The body comes back as text, cut at ${policy.bodyChars} characters, and the answer says truncated when it was cut. A transport failure is an \`error\` rather than a throw.${hostRule}`,
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

