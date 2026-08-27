import { beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { agentMethods, type ActorMethodState } from "tardie"

import { makeActorClient, makeControlClient, SERVER_ERROR_DETAIL, SERVER_ERROR_TITLE, UNEXPECTED_RESPONSE_TITLE } from "./client"
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, projection, projectionsOf } from "./contract"
import { ProblemError } from "./problem"

// The client against a stand-in for the network. What is asserted here is what the client decides
// on its own: the address a call goes to, the header a token rides on, and the error a failed call
// throws. What the server answers is asserted against a real server in apps/server/src/api.test.ts.

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

const calls: Array<Call> = []

// The transport encodes a JSON payload before it reaches fetch, so the recorded body is bytes as
// often as it is a string.
const bodyOf = (body: unknown): string | undefined => {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return undefined
}

const emptyList = () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })

let answer: () => Response = emptyList

// The stand-in is stated to the client rather than assigned to `globalThis`. The transport reads
// its default once per process, so a global assigned after any other fetch-backed request would
// never be consulted and these calls would reach whatever owns the port.
const stub = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? {})
  calls.push({
    url: String(input),
    method: init?.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    body: bodyOf(init?.body)
  })
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
  test("discovers models at the versioned collection", async () => {
    answer = () => Response.json({
      revision: "catalog-1",
      refreshed_at: 1,
      status: "fresh",
      policy: { allow: "*" },
      total: 0,
      limit: 50,
      items: []
    })
    await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).models({
      availability: "available",
      provider: "openrouter",
      search: "claude",
      cursor: "next",
      limit: 25,
      sort: "completionUsdPerToken",
      order: "desc",
      unpriced: "last"
    })
    const url = lastUrl()
    expect(url.pathname).toBe("/v1/models")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      availability: "available",
      provider: "openrouter",
      search: "claude",
      cursor: "next",
      limit: "25",
      sort: "completionUsdPerToken",
      order: "desc",
      unpriced: "last"
    })
  })

  test("discovers provider requirements at the versioned collection", async () => {
    answer = () => Response.json({
      revision: "catalog-1",
      refreshed_at: 1,
      status: "fresh",
      policy: { allow: "*" },
      total: 0,
      limit: 50,
      items: []
    })
    await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).providers({ search: "google" })
    expect(lastUrl().pathname).toBe("/v1/providers")
    expect(lastUrl().searchParams.get("search")).toBe("google")
  })

  test("discovers actors at the collection", async () => {
    await makeControlClient({ baseUrl: "http://localhost:4111", fetch: stub }).actors()
    expect(lastUrl().pathname).toBe("/v1/actors")
  })

  test("pushes an actor through the control plane", async () => {
    answer = () => Response.json({ name: "reviewer", builtIn: false, digest: "sha256:reviewer" })
    await makeControlClient({ baseUrl: "http://localhost:4111", fetch: stub }).pushActor({
      manifest: {
        schema: 3,
        name: "reviewer",
        module: "actor.js",
        digest: "sha256:reviewer"
      },
      module: "export default {}"
    })
    expect(lastUrl().pathname).toBe("/v1/actors")
    expect(calls.at(-1)?.method).toBe("PUT")
  })

  test("reads the mounted actor metadata", async () => {
    answer = () => Response.json({ name: "reviewer", storage: { kind: "sqlite", location: "/work/.tardigrade/actor.sqlite" } })
    const metadata = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).metadata()
    expect(metadata).toEqual({ name: "reviewer", storage: { kind: "sqlite", location: "/work/.tardigrade/actor.sqlite" } })
    expect(lastUrl().pathname).toBe("/v1/metadata")
  })

  // The transport reads its default fetch once per process, so a stated one is the only way a
  // caller routes requests elsewhere: a global assigned later is never consulted (client.ts,
  // ActorClientOptions.fetch).
  test("sends every request through the stated fetch", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).list()
    expect(calls).toHaveLength(1)
    expect(lastUrl().pathname).toBe("/v1/threads")
  })

  test("a thread id is encoded into the path", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("ag/one two")
    expect(lastUrl().pathname).toBe("/v1/threads/ag%2Fone%20two/events")
  })

  test("a stated option is a query param and an absent one is absent", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("root", { after: 40, types: ["MessageReceived", "TurnEnded"] })
    const url = lastUrl()
    expect(url.searchParams.get("after")).toBe("40")
    expect(url.searchParams.get("types")).toBe("MessageReceived,TurnEnded")
    expect(url.searchParams.has("limit")).toBe(false)
  })

  test("a base with a trailing slash does not double it", async () => {
    await makeActorClient({ baseUrl: "http://127.0.0.1:4111/" , fetch: stub }).list()
    expect(calls[0]!.url).toBe("http://127.0.0.1:4111/v1/threads")
  })
})

describe("the token", () => {
  test("rides an authorization header on every request", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", token: "shh" , fetch: stub })
    await client.list()
    await client.events("root")
    expect(calls.map((call) => call.headers["authorization"])).toEqual(["Bearer shh", "Bearer shh"])
  })

  test("no token means no header", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list()
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
  })
})

describe("a declared actor method", () => {
  test("discovers method schemas at the actor", async () => {
    answer = () => new Response(JSON.stringify([{
      name: "message",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" }
    }]), { status: 200, headers: { "content-type": "application/json" } })
    const methods = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).methods()
    expect(methods[0]?.name).toBe("message")
    expect(lastUrl().pathname).toBe("/v1/methods")
  })

  test("invokes the selected method with its typed input", async () => {
    answer = () => new Response(JSON.stringify({
      thread: "root",
      method: "message",
      call: "m1"
    }), { status: 202, headers: { "content-type": "application/json" } })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const accepted = await client.invoke("root", "message", { id: "m1", input: { text: "hello" } })
    expect(accepted.call).toBe("m1")
    expect(calls[0]?.method).toBe("PUT")
    expect(lastUrl().pathname).toBe("/v1/threads/root/methods/message/calls/m1")
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ text: "hello" })
  })

  test("reads and types completed output from the declaration", async () => {
    answer = () => new Response(JSON.stringify({ status: "completed", output: "done" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const state: ActorMethodState<string> = await client.methodState("root", "message", "m1")
    expect(state).toEqual({ status: "completed", output: "done" })
    expect(lastUrl().pathname).toBe("/v1/threads/root/methods/message/calls/m1")
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
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("ghost").catch((error: unknown) => error)
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
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list().catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe("Unauthorized")
    expect(failure.status).toBe(401)
    expect(failure.detail).toBe("This server requires a bearer token.")
  })

  test("a body that is not a problem document falls back to the status", async () => {
    answer = () => new Response("<html>", { status: 418, headers: { "content-type": "text/html" } })
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list().catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe(UNEXPECTED_RESPONSE_TITLE)
    expect(failure.status).toBe(418)
  })

  test("an undocumented server failure gives an actionable message", async () => {
    answer = () => new Response(null, { status: 500 })
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).list().catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe(SERVER_ERROR_TITLE)
    expect(failure.status).toBe(500)
    expect(failure.detail).toBe(SERVER_ERROR_DETAIL)
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
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    await client.projection("root", "turns", { at: 3 })
    expect(lastUrl().pathname).toBe("/v1/threads/root/projections/turns")
    expect(lastUrl().searchParams.get("at")).toBe("3")
  })

  test("an absent query is an absent param rather than a stated default", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
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
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    const views: ReadonlyArray<{ readonly turn: string; readonly status: string }> = await client.projection(
      "root",
      "turns"
    )
    expect(views).toEqual([{ turn: "m1", status: "completed" }])
  })
})

// A resume is an appended TurnResumed and nothing else. The platform has no resume route, so the
// guard and the epoch arithmetic are the SDK's, and both read the actor's turns projection.
describe("resuming a turn", () => {
  // A resume is two exchanges: the projection it reads, then the append it makes. The stand-in
  // answers by method, because both go to the same server.
  const accepting = (view: unknown) => {
    let read = false
    return () => {
      if (read) {
        return new Response(JSON.stringify({ thread: "root" }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      }
      read = true
      return new Response(JSON.stringify(view === undefined ? [] : [view]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  }

  const projections = projectionsOf({
    turns: projection({
      params: { at: Schema.optionalKey(Schema.Int), turn: Schema.optionalKey(Schema.String) },
      result: Schema.Array(
        Schema.Struct({
          turn: Schema.String,
          status: Schema.Literals(["pending", "completed", "failed", "parked"]),
          epoch: Schema.Finite,
          output: Schema.optionalKey(Schema.String),
          error: Schema.optionalKey(Schema.String)
        })
      ),
      run: () => []
    })
  })

  const client = () => makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })

  test("a failed turn appends the TurnResumed its reactors interpret", async () => {
    answer = accepting({ turn: "m1", status: "failed", epoch: 0, error: "boom" })
    const accepted = await client().resume("root", "m1")
    expect(accepted).toEqual({ thread: "root" })
    // Two calls: the projection it read, then the append it made.
    expect(calls).toHaveLength(2)
    const read = new URL(calls[0]!.url)
    expect(read.pathname).toBe("/v1/threads/root/projections/turns")
    expect(read.searchParams.get("turn")).toBe("m1")
    const appended = new URL(calls[1]!.url)
    expect(appended.pathname).toBe("/v1/threads/root/events")
    expect(JSON.parse(calls[1]!.body ?? "")).toEqual({
      type: "TurnResumed",
      turn: "m1",
      failedEpoch: 0,
      epoch: 1
    })
  })

  // The epoch is read rather than assumed, so resuming an already-resumed turn starts the next one
  // rather than restating the last (packages/agent/src/runtime/resume.ts, resumeTurn).
  test("the appended epoch is the one after the turn's active attempt", async () => {
    answer = accepting({ turn: "m1", status: "failed", epoch: 2, error: "boom" })
    await client().resume("root", "m1")
    expect(JSON.parse(calls[1]!.body ?? "")).toMatchObject({ failedEpoch: 2, epoch: 3 })
  })

  test("a turn that did not fail is refused, and nothing is appended", async () => {
    answer = accepting({ turn: "m1", status: "completed", epoch: 0, output: "done" })
    const failure = await client().resume("root", "m1").then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).title).toBe("Resume Refused")
    expect((failure as ProblemError).status).toBe(409)
    expect((failure as ProblemError).detail).toContain("its active epoch is completed")
    expect(calls).toHaveLength(1)
  })

  test("a turn nobody was asked to serve is refused too", async () => {
    answer = accepting(undefined)
    const failure = await client().resume("root", "m9").then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).detail).toContain('No turn named "m9"')
    expect(calls).toHaveLength(1)
  })

  // `resume` is on every client, and the declaration it needs is not, so a client that reads the
  // log alone says why rather than failing on an undefined call.
  test("a client built with no turns projection says so", async () => {
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub })
      .resume("root", "m1")
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).detail).toContain("without a `turns` projection")
    expect(calls).toHaveLength(0)
  })
})
