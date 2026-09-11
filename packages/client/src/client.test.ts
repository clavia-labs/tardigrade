import { beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { ACTOR_ARTIFACT_VERSION, agentMethods } from "@clavia/tardigrade-agent"
import type { ActorMethodState } from "@clavia/tardigrade-core/interaction/state"

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

  test("discovers definitions at the collection", async () => {
    await makeControlClient({ baseUrl: "http://localhost:4111", fetch: stub }).definitions()
    expect(lastUrl().pathname).toBe("/v1/definitions")
  })

  test("pushes an actor through the control plane", async () => {
    answer = () => Response.json({ name: "reviewer", builtIn: false, digest: "sha256:reviewer" })
    await makeControlClient({ baseUrl: "http://localhost:4111", fetch: stub }).pushDefinition({
      manifest: {
        schema: ACTOR_ARTIFACT_VERSION,
        name: "reviewer",
        module: "actor.js",
        digest: "sha256:reviewer"
      },
      module: "export default {}"
    })
    expect(lastUrl().pathname).toBe("/v1/definitions")
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
    await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).list("main")
    expect(calls).toHaveLength(1)
    expect(lastUrl().pathname).toBe("/v1/actors/main/threads")
  })

  test("a thread id is encoded into the path", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("main", "ag/one two")
    expect(lastUrl().pathname).toBe("/v1/actors/main/threads/ag%2Fone%20two/events")
  })

  test("a stated option is a query param and an absent one is absent", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("main", "root", { after: 40, types: ["MessageReceived", "TurnEnded"] })
    const url = lastUrl()
    expect(url.searchParams.get("after")).toBe("40")
    expect(url.searchParams.get("types")).toBe("MessageReceived,TurnEnded")
    expect(url.searchParams.has("limit")).toBe(false)
  })

  test("stated bounds are query params on the tree and roster reads, absent ones absent", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub })
    await client.list("main", { root: "inv-81", maxDepth: 2, maxNodes: 50 })
    answer = () => Response.json({ id: "inv-81", depth: 0, events: 1, status: "settled", children: [] })
    await client.tree("main", "inv-81", { maxDepth: 1 })
    const roster = new URL(calls[0]!.url)
    const tree = new URL(calls[1]!.url)
    expect(roster.searchParams.get("root")).toBe("inv-81")
    expect(roster.searchParams.get("maxDepth")).toBe("2")
    expect(roster.searchParams.get("maxNodes")).toBe("50")
    expect(tree.pathname).toBe("/v1/actors/main/threads/inv-81/tree")
    expect(tree.searchParams.get("maxDepth")).toBe("1")
    expect(tree.searchParams.has("root")).toBe(false)
    expect(tree.searchParams.has("maxNodes")).toBe(false)
  })

  test("a base with a trailing slash does not double it", async () => {
    await makeActorClient({ baseUrl: "http://127.0.0.1:4111/" , fetch: stub }).list("main")
    expect(calls[0]!.url).toBe("http://127.0.0.1:4111/v1/actors/main/threads")
  })
})

describe("the token", () => {
  test("rides an authorization header on every request", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", token: "shh" , fetch: stub })
    await client.list("main")
    await client.events("main", "root")
    expect(calls.map((call) => call.headers["authorization"])).toEqual(["Bearer shh", "Bearer shh"])
  })

  test("no token means no header", async () => {
    await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list("main")
    expect(calls[0]!.headers["authorization"]).toBeUndefined()
  })
})

describe("a declared actor method", () => {
  test("allocates a root name and returns its assigned coordinate", async () => {
    const coordinate = { actor: "agent", instance: "rick", thread: "assigned-root" }
    answer = () => new Response(JSON.stringify(coordinate), { headers: { "content-type": "application/json" } })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub })
    expect(await client.allocateRoot("rick", "lab")).toEqual(coordinate)
    expect(calls[0]?.method).toBe("POST")
    expect(lastUrl().pathname).toBe("/v1/actors/rick/threads")
    expect(await client.allocateRoot("rick")).toEqual(coordinate)
  })
  test("forks a source prefix onto a named destination", async () => {
    const coordinate = { actor: "agent", instance: "rick", thread: "experiment" }
    answer = () => new Response(JSON.stringify(coordinate), { headers: { "content-type": "application/json" } })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub })
    expect(await client.fork("rick", "root", "m1", "experiment")).toEqual(coordinate)
    expect(calls[0]?.method).toBe("POST")
    expect(lastUrl().pathname).toBe("/v1/actors/rick/threads/root/fork")
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ until: "m1", name: "experiment" })
    expect(await client.fork("rick", "root", 2)).toEqual(coordinate)
    expect(JSON.parse(calls[1]!.body ?? "")).toEqual({ until: 2 })
  })
  test("discovers method schemas at the actor", async () => {
    answer = () => new Response(JSON.stringify([{
      name: "message",
      cancellable: true,
      timeoutMs: 300_000,
      inputSchema: { type: "object" },
      outputSchema: { type: "string" }
    }]), { status: 200, headers: { "content-type": "application/json" } })
    const methods = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).methods()
    expect(methods[0]?.name).toBe("message")
    expect(lastUrl().pathname).toBe("/v1/methods")
  })

  test("invokes the selected method with its typed input", async () => {
    answer = () => new Response(JSON.stringify({
      actor: "main",
      thread: "root",
      method: "message",
      call: "m1",
      deadlineAt: 301_000,
      reference: { target: { actor: "agent", instance: "main", thread: "root" }, invocation: { method: "message", id: "m1", epoch: 0 } }
    }), { status: 202, headers: { "content-type": "application/json" } })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const accepted = await client.call("main", "root", "message", {
      id: "m1",
      input: { text: "hello" },
      timeoutMs: 1_000
    })
    expect(accepted.id).toBe("m1")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers["idempotency-key"]).toBe("m1")
    expect(lastUrl().pathname).toBe("/v1/actors/main/threads/root/methods/message")
    expect(lastUrl().searchParams.get("timeoutMs")).toBe("1000")
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ text: "hello" })
  })

  test("reads and types completed output from the declaration", async () => {
    answer = () => new Response(JSON.stringify({ status: "completed", output: "done" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const state: ActorMethodState<string> = await client.methodState("main", "root", "message", "m1")
    expect(state).toEqual({ status: "completed", output: "done" })
    expect(lastUrl().pathname).toBe("/v1/actors/main/threads/root/methods/message/calls/m1")
  })

  test("reference operations carry the actor and exact epoch", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const reference = { target: { actor: "agent", instance: "main", thread: "root" }, invocation: { method: "message", id: "m1", epoch: 2 } }
    answer = () => Response.json({ status: "pending" })
    await client.state(reference)
    expect(lastUrl().searchParams.get("epoch")).toBe("2")
    expect(lastUrl().searchParams.get("actor")).toBe("agent")
    answer = () => Response.json({ actor: "main", thread: "root", method: "message", call: "m1", status: "requested" }, { status: 202 })
    await client.cancel(reference)
    expect(lastUrl().searchParams.get("epoch")).toBe("2")
    expect(lastUrl().searchParams.get("actor")).toBe("agent")
    expect(() => client.state({ reference, actor: "main", thread: "other", method: "message", id: "m1" })).toThrow("does not match")
  })

  test("reads state and requests cancellation through the invocation handle", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, methods: agentMethods })
    const invocation = {
      actor: "main",
      thread: "root",
      method: "message",
      id: "m1",
      deadlineAt: 301_000
    } as const

    answer = () => Response.json({ status: "pending" })
    await client.state(invocation)
    expect(lastUrl().searchParams.has("epoch")).toBe(false)

    answer = () => new Response(JSON.stringify({
      actor: "main",
      thread: "root",
      method: "message",
      call: "m1",
      status: "requested"
    }), { status: 202, headers: { "content-type": "application/json" } })
    expect(await client.cancel(invocation, { reason: "operator stopped it" })).toMatchObject({ status: "requested" })
    expect(lastUrl().pathname).toBe(
      "/v1/actors/main/threads/root/methods/message/calls/m1/cancellation"
    )
    expect(JSON.parse(calls.at(-1)!.body ?? "")).toEqual({ reason: "operator stopped it" })

    answer = () => Response.json({
      actor: "main",
      thread: "root",
      method: "message",
      call: "m1",
      status: "cancelled"
    })
    expect(await client.cancel(invocation)).toMatchObject({ status: "cancelled" })
    expect(lastUrl().pathname).toBe(
      "/v1/actors/main/threads/root/methods/message/calls/m1/cancellation"
    )
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
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).events("main", "ghost").catch((error: unknown) => error)
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
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list("main").catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe("Unauthorized")
    expect(failure.status).toBe(401)
    expect(failure.detail).toBe("This server requires a bearer token.")
  })

  test("a body that is not a problem document falls back to the status", async () => {
    answer = () => new Response("<html>", { status: 418, headers: { "content-type": "text/html" } })
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111" , fetch: stub }).list("main").catch((error: unknown) => error) as ProblemError
    expect(failure.title).toBe(UNEXPECTED_RESPONSE_TITLE)
    expect(failure.status).toBe(418)
  })

  test("an undocumented server failure gives an actionable message", async () => {
    answer = () => new Response(null, { status: 500 })
    const failure = await makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub }).list("main").catch((error: unknown) => error) as ProblemError
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
    await client.projection("main", "root", "turns", { at: 3 })
    expect(lastUrl().pathname).toBe("/v1/actors/main/threads/root/projections/turns")
    expect(lastUrl().searchParams.get("at")).toBe("3")
  })

  test("an absent query is an absent param rather than a stated default", async () => {
    const client = makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub, projections })
    await client.projection("main", "root", "turns")
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
      "main",
      "root",
      "turns"
    )
    expect(views).toEqual([{ turn: "m1", status: "completed" }])
  })
})

describe("resuming a turn", () => {
  const accepting = (events: ReadonlyArray<Record<string, unknown>>, pageSize = events.length || 1) => () => {
    if (calls.at(-1)!.method === "POST") return new Response(JSON.stringify({ actor: "main", thread: "root" }), {
      status: 202, headers: { "content-type": "application/json" }
    })
    const after = Number(lastUrl().searchParams.get("after") ?? 0)
    return new Response(JSON.stringify(events.slice(after, after + pageSize).map((event, index) => ({ seq: after + index + 1, event }))), {
      status: 200, headers: { "content-type": "application/json" }
    })
  }
  const message = { type: "MessageReceived", id: "m1" }
  const failed = { type: "TurnFailed", turn: "m1", error: "boom" }
  const client = () => makeActorClient({ baseUrl: "http://localhost:4111", fetch: stub })

  test("resuming a failed turn is invariant under consistent ID renaming", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1 }), fc.string({ minLength: 1 }),
      async (original, renamed) => {
        const resume = async (turn: string) => {
          calls.length = 0
          answer = accepting([{ ...message, id: turn }, { ...failed, turn }])
          const result = await client().resume("main", "root", turn)
          expect(calls).toHaveLength(3)
          expect(calls.every((call) => new URL(call.url).pathname === "/v1/actors/main/threads/root/events")).toBe(true)
          const event = JSON.parse(calls.at(-1)!.body!)
          expect(event).toEqual({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 1 })
          return { result, event: { ...event, turn: "<turn>" } }
        }
        expect(await resume(renamed)).toEqual(await resume(original))
      }
    ), { numRuns: 200 })
  })

  test("resume follows every event page", async () => {
    answer = accepting([
      message, failed,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1 },
      { ...failed, epoch: 1 },
      { type: "TurnResumed", turn: "m1", failedEpoch: 1, epoch: 2 },
      { ...failed, epoch: 2 }
    ], 2)
    await client().resume("main", "root", "m1")
    expect(calls.filter((call) => call.method === "GET").map((call) => new URL(call.url).searchParams.get("after"))).toEqual(["0", "2", "4", "6"])
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ failedEpoch: 2, epoch: 3 })
  })

  test.each([
    ["completed", [{ type: "TurnCompleted", turn: "m1", output: "done" }]],
    ["pending", []],
    ["pending", [failed, { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1 }]],
    ["cancelled", [{ type: "TurnCancelled", turn: "m1", cause: "requested" }]],
    ["parked", [{ type: "BudgetRequested", turn: "m1", callId: "budget", amount: 1 }]]
  ] as const)("refuses a %s active epoch", async (status, events) => {
    answer = accepting([message, ...events])
    const failure = await client().resume("main", "root", "m1").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).status).toBe(409)
    expect((failure as ProblemError).detail).toContain(`its active epoch is ${status}`)
    expect(calls.every((call) => call.method === "GET")).toBe(true)
  })

  test("a nonadvancing event page is refused without appending", async () => {
    answer = () => new Response(JSON.stringify([{ seq: 1, event: message }]), {
      headers: { "content-type": "application/json" }
    })
    const failure = await client().resume("main", "root", "m1").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).detail).toContain("did not advance")
    expect(calls).toHaveLength(2)
  })

  test("a turn nobody was asked to serve is refused", async () => {
    answer = accepting([])
    const failure = await client().resume("main", "root", "m9").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProblemError)
    expect((failure as ProblemError).detail).toContain('No turn named "m9"')
    expect(calls).toHaveLength(1)
  })
})
