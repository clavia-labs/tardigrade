import { beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { makeClient, UNEXPECTED_RESPONSE_TITLE } from "./client"
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, projection, projectionsOf } from "./contract"
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
    expect(lastUrl().pathname).toBe("/v1/actors/agent/threads")
  })

  test("a thread id is encoded into the path", async () => {
    await makeClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("ag/one two")
    expect(lastUrl().pathname).toBe("/v1/actors/agent/threads/ag%2Fone%20two/events")
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
    expect(calls[0]!.url).toBe("http://127.0.0.1:4111/v1/actors/agent/threads")
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
      type: `${PROBLEM_TYPE_BASE}unknown-thread`,
      title: "Unknown Thread",
      status: 404,
      detail: 'No thread named "ghost" has ever existed.'
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

// The platform's API is the log, and everything else a thread can be asked is a projection its
// actor declares. A client states the same declaration the server mounts, and gets a call typed by
// it (contract.ts, apiOf; apps/server/src/actor.ts).
describe("a declared projection", () => {
  const projections = projectionsOf({
    turns: projection({
      params: { at: Schema.optionalKey(Schema.Int) },
      result: Schema.Array(Schema.Struct({ turn: Schema.String, status: Schema.String })),
      run: () => []
    })
  })

  test("serves at the name it was declared under, and carries its own query", async () => {
    const client = makeClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    await client.projection("root", "turns", { at: 3 })
    expect(lastUrl().pathname).toBe("/v1/actors/agent/threads/root/turns")
    expect(lastUrl().searchParams.get("at")).toBe("3")
  })

  test("an absent query is an absent param rather than a stated default", async () => {
    const client = makeClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    await client.projection("root", "turns")
    expect(lastUrl().searchParams.has("at")).toBe(false)
  })

  // The declaration's own types reach the call: the name is one it declares, the query is what that
  // projection accepts, and the answer is what it promises. A name it does not declare, or a query
  // field it does not accept, does not compile.
  test("types the answer from the declaration", async () => {
    answer = () =>
      new Response(JSON.stringify([{ turn: "m1", status: "completed" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    const client = makeClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    const views: ReadonlyArray<{ readonly turn: string; readonly status: string }> = await client.projection(
      "root",
      "turns"
    )
    expect(views).toEqual([{ turn: "m1", status: "completed" }])
  })
})
