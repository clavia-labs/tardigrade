import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import type { Park } from "../execution/errors"

import { DEFAULT_FETCH_BODY_CHARS, DEFAULT_FETCH_POLICY, fetchPackage, fetchPolicyOf, type FetchPolicy } from "./fetch"

// The fetch package against a server this file boots. Nothing here reaches the network: the origin
// is loopback on a port the runtime chose, so the test is the same on a laptop and in a sandbox.
// The urlPolicy cases reach further hosts the same way, as refusals the server never sees, and the
// public-host cases bind a fetch this file stubs, so no test opens a socket to a third party.

interface Answer {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly truncated?: boolean
  readonly error?: string
}

let origin = ""
let hits = 0
let server: ReturnType<typeof Bun.serve> | undefined

const run = (effect: Effect.Effect<unknown, Park, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.provide(Effect.orDie(effect), FetchHttpClient.layer)) as Promise<Answer>

const call = (method: string, args: unknown, policy: Partial<FetchPolicy> = {}) => {
  const pkg = fetchPackage({ policy })
  return run(pkg.methods[method]!(args, { callId: "c1" }))
}

// callThroughFetch runs one get through the real FetchHttpClient transport over a fetch this test
// states, so the urlPolicy's transport behavior is observable without a public socket: the stub
// reads the RequestInit the package pinned, and answers what the policy must handle.
const callThroughFetch = (
  respond: (init: RequestInit) => Promise<Response>,
  args: unknown,
  policy: Partial<FetchPolicy> = {}
): Promise<Answer> => {
  const pkg = fetchPackage({ policy })
  const fetchImpl: typeof globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => respond(init ?? {}),
    { preconnect: () => undefined }
  )
  return Effect.runPromise(Effect.provideService(
    Effect.orDie(Effect.provide(pkg.methods["get"]!(args, { callId: "c1" }), FetchHttpClient.layer)),
    FetchHttpClient.Fetch,
    fetchImpl
  )) as Promise<Answer>
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      hits++
      const url = new URL(request.url)
      if (url.pathname === "/long") return new Response("x".repeat(1000))
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/" } })
      }
      if (url.pathname === "/echo") {
        return new Response(`${request.method}:${await request.text()}`, {
          status: 201,
          headers: { "x-seen": request.headers.get("x-ask") ?? "" }
        })
      }
      if (url.pathname === "/teapot") return new Response("no coffee", { status: 418 })
      return new Response("hello", { headers: { "content-type": "text/plain" } })
    }
  })
  origin = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
})

describe("the fetch policy", () => {
  test("the cap is an exported default and an override", () => {
    expect(DEFAULT_FETCH_POLICY.bodyChars).toBe(DEFAULT_FETCH_BODY_CHARS)
    expect(fetchPolicyOf().bodyChars).toBe(DEFAULT_FETCH_BODY_CHARS)
    expect(fetchPolicyOf({ bodyChars: 10 }).bodyChars).toBe(10)
  })

  test("the urlPolicy is opt-in and off by default", () => {
    expect(DEFAULT_FETCH_POLICY.urlPolicy).toBeUndefined()
    expect(fetchPolicyOf().urlPolicy).toBeUndefined()
    expect(fetchPolicyOf({ urlPolicy: "public-only" }).urlPolicy).toBe("public-only")
  })
})

describe("the urlPolicy", () => {
  test("refuses a loopback address, however it was written", async () => {
    const before = hits
    const answer = await call("get", { url: `${origin}/` }, { urlPolicy: "public-only" })
    expect(answer.error).toContain("refuses the loopback address 127.0.0.1")
    expect(answer.status).toBeUndefined()
    const odd = await call("get", { url: "http://0x7f.1/" }, { urlPolicy: "public-only" })
    expect(odd.error).toContain("refuses the loopback address 127.0.0.1")
    expect(hits).toBe(before)
  })

  // One call per RFC 1918 range: the three ranges are three branches of the classifier, and each
  // is a distinct address an operator's network may answer on.
  test("refuses each private range", async () => {
    for (const host of ["10.0.0.1", "172.16.0.9", "192.168.1.1"]) {
      const answer = await call("get", { url: `http://${host}/` }, { urlPolicy: "public-only" })
      expect(answer.error).toContain(`refuses the private address ${host}`)
      expect(answer.status).toBeUndefined()
    }
  })

  test("refuses the link-local range", async () => {
    const answer = await call("get", { url: "http://169.254.169.254/latest/meta-data" }, { urlPolicy: "public-only" })
    expect(answer.error).toContain("refuses the link-local address 169.254.169.254")
    expect(answer.status).toBeUndefined()
  })

  test("refuses a literal IP address, public or IPv6", async () => {
    const four = await call("get", { url: "https://8.8.8.8/" }, { urlPolicy: "public-only" })
    expect(four.error).toContain("refuses the literal IP address 8.8.8.8")
    const six = await call("get", { url: "http://[2001:db8::1]/" }, { urlPolicy: "public-only" })
    expect(six.error).toContain("refuses the literal IP address [2001:db8::1]")
  })

  test("refuses the loopback name", async () => {
    const answer = await call("get", { url: "http://localhost:1/x" }, { urlPolicy: "public-only" })
    expect(answer.error).toContain("refuses the loopback name localhost")
    expect(answer.status).toBeUndefined()
  })

  test("refuses a scheme other than http and https, and what it cannot parse", async () => {
    const scheme = await call("get", { url: "ftp://example.com/" }, { urlPolicy: "public-only" })
    expect(scheme.error).toContain("refuses the ftp: scheme")
    const broken = await call("get", { url: "not a url" }, { urlPolicy: "public-only" })
    expect(broken.error).toContain("needs an absolute http or https URL")
  })

  test("passes a public host to the transport with redirects pinned to error", async () => {
    const seen: Array<RequestInit> = []
    const answer = await callThroughFetch((init) => {
      seen.push(init)
      return Promise.resolve(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }))
    }, { url: "https://example.com/" }, { urlPolicy: "public-only" })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe("hello")
    expect(seen[0]?.redirect).toBe("error")
  })

  // A transport that ignores the RequestInit pin still cannot land a redirect as an answer.
  test("refuses a redirect the transport surfaces", async () => {
    const answer = await callThroughFetch(() => Promise.resolve(new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/" }
    })), { url: "https://example.com/" }, { urlPolicy: "public-only" })
    expect(answer.error).toContain("refuses a redirect")
    expect(answer.status).toBeUndefined()
  })
})

describe("the fetch package", () => {
  test("a get answers with the status, the headers, and the body", async () => {
    const answer = await call("get", { url: `${origin}/` })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe("hello")
    expect(answer.headers?.["content-type"]).toContain("text/plain")
  })

  // A status the caller did not want is still an answer: the model reads the number and decides,
  // rather than the attempt failing on a 418.
  test("a refusing status is an answer, not a failure", async () => {
    const answer = await call("get", { url: `${origin}/teapot` })
    expect(answer.status).toBe(418)
    expect(answer.body).toBe("no coffee")
    expect(answer.error).toBeUndefined()
  })

  test("a body past the cap is cut and says truncated", async () => {
    const answer = await call("get", { url: `${origin}/long` }, { bodyChars: 16 })
    expect(answer.body).toBe("x".repeat(16))
    expect(answer.truncated).toBe(true)
  })

  test("a request carries its method, its headers, and its body", async () => {
    const answer = await call("request", {
      method: "post",
      url: `${origin}/echo`,
      headers: { "x-ask": "here" },
      body: "payload"
    })
    expect(answer.status).toBe(201)
    expect(answer.body).toBe("POST:payload")
    expect(answer.headers?.["x-seen"]).toBe("here")
  })

  test("a method nobody defined is an error the model reads", async () => {
    const answer = await call("request", { method: "TRACE", url: `${origin}/` })
    expect(answer.error).toContain("method")
    expect(answer.status).toBeUndefined()
  })

  test("a host that answers nothing is an error the model reads", async () => {
    const answer = await call("get", { url: "http://127.0.0.1:1/" })
    expect(answer.error).toContain("127.0.0.1:1")
    expect(answer.status).toBeUndefined()
  })

  // The default package stays the open one: without the urlPolicy a redirect is followed to its
  // target, which is the behavior an opting-out host keeps.
  test("a redirect is followed when no urlPolicy is set", async () => {
    const answer = await call("get", { url: `${origin}/redirect` })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe("hello")
  })

  test("get is read-only and request is not, and both are open world", () => {
    const pkg = fetchPackage()
    expect(pkg.annotations?.["get"]).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: true })
    expect(pkg.annotations?.["request"]?.readOnlyHint).toBe(false)
    expect(pkg.annotations?.["request"]?.destructiveHint).toBe(true)
    expect(pkg.annotations?.["request"]?.openWorldHint).toBe(true)
  })
})
