import { beforeEach, describe, expect, test } from "bun:test"

import { makeClient, UNEXPECTED_RESPONSE_TITLE } from "./client"
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE } from "./contract"
import { ProblemError } from "./problem"

// The client against a stand-in for the network. What is asserted here is what the client decides
// on its own: the address a call goes to, the header a token rides on, and the error a failed call
// throws. What the server answers is asserted against a real server in apps/server/src/api.test.ts.

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
}

const calls: Array<Call> = []

const emptyList = () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })

let answer: () => Response = emptyList

// The stand-in is stated to the client rather than assigned to `globalThis`. The transport reads
// its default once per process, so a global assigned after any other fetch-backed request would
// never be consulted and these calls would reach whatever owns the port.
const stub = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? {})
  calls.push({ url: String(input), headers: Object.fromEntries(headers.entries()) })
  return Promise.resolve(answer())
}) as typeof globalThis.fetch

beforeEach(() => {
  calls.length = 0
  answer = emptyList
})

const lastUrl = (): URL => new URL(calls[calls.length - 1]!.url)

const problemAnswer = (status: number, document: unknown) => () =>
  new Response(JSON.stringify(document), { status, headers: { "content-type": PROBLEM_CONTENT_TYPE } })

describe("the address a call goes to", () => {
  // The transport reads its default fetch once per process, so a stated one is the only way a
  // caller routes requests elsewhere: a global assigned later is never consulted (client.ts,
  // ClientOptions.fetch).
  test("sends every request through the stated fetch", async () => {
    await makeClient({ baseUrl: "http://localhost:4111", fetch: stub }).list()
    expect(calls).toHaveLength(1)
    expect(lastUrl().pathname).toBe("/agents")
  })

  test("an agent id is encoded into the path", async () => {
    await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("ag/one two")
    expect(lastUrl().pathname).toBe("/agents/ag%2Fone%20two/events")
  })

  test("a stated option is a query param and an absent one is absent", async () => {
    await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("root", { after: 40, types: ["MessageReceived", "TurnEnded"] })
    const url = lastUrl()
    expect(url.searchParams.get("after")).toBe("40")
    expect(url.searchParams.get("types")).toBe("MessageReceived,TurnEnded")
    expect(url.searchParams.has("limit")).toBe(false)
  })

  test("a base with a trailing slash does not double it", async () => {
    await makeClient({ baseUrl: "http://127.0.0.1:4111/" , fetch: stub }).list()
    expect(calls[0]!.url).toBe("http://127.0.0.1:4111/agents")
  })
})

describe("the token", () => {
  test("rides an authorization header on every request", async () => {
    const client = makeClient({ baseUrl: "http://localhost:4111", token: "shh" , fetch: stub })
    await client.list()
    await client.events("root")
    expect(calls.map((call) => call.headers["authorization"])).toEqual(["Bearer shh", "Bearer shh"])
  })

  test("no token means no header", async () => {
    await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list()
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
  })
})

describe("a failed call", () => {
  test("a declared problem+json failure keeps all four fields", async () => {
    const document = {
      type: `${PROBLEM_TYPE_BASE}unknown-agent`,
      title: "Unknown Agent",
      status: 404,
      detail: 'No agent named "ghost" has ever existed.'
    }
    answer = problemAnswer(404, document)
    const failure = await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("ghost").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    const problem = failure as ProblemError
    expect(problem.type).toBe(document.type)
    expect(problem.title).toBe(document.title)
    expect(problem.status).toBe(404)
    expect(problem.detail).toBe(document.detail)
  })

  test("a status the declaration does not name still surfaces its document", async () => {
    // 401 is the bearer gate's, which stands in front of every declared endpoint
    // (apps/server/src/http.ts, layerAuth), so it is a document the client never declared.
    answer = problemAnswer(401, {
      type: `${PROBLEM_TYPE_BASE}unauthorized`,
      title: "Unauthorized",
      status: 401,
      detail: "This server requires a bearer token."
    })
    const failure = await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list().catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe("Unauthorized")
    expect(failure.status).toBe(401)
    expect(failure.detail).toBe("This server requires a bearer token.")
  })

  test("a body that is not a problem document falls back to the status", async () => {
    answer = () => new Response("<html>", { status: 502, headers: { "content-type": "text/html" } })
    const failure = await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list().catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe(UNEXPECTED_RESPONSE_TITLE)
    expect(failure.status).toBe(502)
  })
})
