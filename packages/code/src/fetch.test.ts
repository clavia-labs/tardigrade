import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import type { Park } from "./errors"

import { DEFAULT_FETCH_BODY_CHARS, DEFAULT_FETCH_POLICY, fetchPackage, fetchPolicyOf } from "./fetch"

// The fetch package against a server this file boots. Nothing here reaches the network: the origin
// is loopback on a port the runtime chose, so the test is the same on a laptop and in a sandbox.

interface Answer {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly truncated?: boolean
  readonly error?: string
}

let origin = ""
let server: ReturnType<typeof Bun.serve> | undefined

const run = (effect: Effect.Effect<unknown, Park, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.provide(Effect.orDie(effect), FetchHttpClient.layer)) as Promise<Answer>

const call = (method: string, args: unknown, policy: Partial<{ bodyChars: number }> = {}) => {
  const pkg = fetchPackage({ policy })
  return run(pkg.methods[method]!(args, { callId: "c1" }))
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/long") return new Response("x".repeat(1000))
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
})

describe("the fetch package", () => {
  test("a get answers with the status, the headers, and the body", async () => {
    const answer = await call("get", { url: `${origin}/` })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe("hello")
    expect(answer.headers?.["content-type"]).toContain("text/plain")
    expect(answer.truncated).toBeUndefined()
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

  test("get is read-only and request is not, and both are open world", () => {
    const pkg = fetchPackage()
    expect(pkg.annotations?.["get"]).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: true })
    expect(pkg.annotations?.["request"]?.readOnlyHint).toBe(false)
    expect(pkg.annotations?.["request"]?.destructiveHint).toBe(true)
    expect(pkg.annotations?.["request"]?.openWorldHint).toBe(true)
  })
})
