import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpBody, HttpClient } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { BunHttpServer } from "@effect/platform-bun"

import { layerConfig, readConfig } from "./config"
import { DOCS_PATH, OPENAPI_PATH } from "@clavia/tardigrade-client/contract"
import { ServerApi } from "./api"
import { Threads, type ActorThreads } from "./host"
import { layerModelCatalogUnavailable } from "./catalog"
import { PROBLEM_CONTENT_TYPE, serve } from "./http"
import { layerGaugeResting } from "./driver-gauge"

// The declaration, from the outside. These assertions are about what the declaration produces: the
// document a client generates from, and the failure shape that document promises. The routes
// themselves are exercised against a real host in api.test.ts.

// A Threads that owns nothing, so every read is the empty log a 404 is made of.
const layerThreadsEmpty = Layer.succeed(Threads)({
  methods: {},
  sqlite: ":memory:",
  instances: Effect.succeed([]),
  ensure: () => Effect.succeed({ methods: {}, sqlite: ":memory:", append: () => Effect.void, events: () => Effect.succeed([]), eventsPage: () => Effect.succeed([]), awaitHead: () => Effect.never, list: Effect.succeed([]), settled: Effect.void }),
  instance: () => Effect.succeed(undefined as ActorThreads | undefined),
  append: () => Effect.void,
  events: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
  settled: () => Effect.void
})

const serving = <A, E>(
  options: { readonly token?: string },
  body: (client: HttpClient.HttpClient) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return yield* body(client)
  }).pipe(
    Effect.provide(
      Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true }), [
        BunHttpServer.layerTest,
        layerConfig({ ...readConfig({}), token: options.token }),
        layerGaugeResting,
        layerModelCatalogUnavailable,
        layerThreadsEmpty
      ])
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

// Every case here boots a real server on an ephemeral port, so it competes with every other task in
// a parallel gate run. Bun's default per-test budget is tuned for a pure function and times out
// under that load; this is the budget a boot actually needs. It stays tight on purpose: a case that
// wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// Every route the server answers, as method and OpenAPI path. The stream is absent because it is not a declared endpoint (api.ts, layerStream). `turns` appears because this build's actor declares it (actor.ts, agentProjections).
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["get", "/v1/providers"],
  ["get", "/v1/models"],
  ["get", "/v1/definitions"],
  ["put", "/v1/definitions"],
  ["get", "/v1/actors"],
  ["get", "/v1/actors/{id}"],
  ["put", "/v1/actors/{id}"],
  ["get", "/v1/metadata"],
  ["get", "/v1/methods"],
  ["post", "/v1/actors/{id}/threads/{thread}/events"],
  ["put", "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}"],
  ["put", "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}/cancellation"],
  ["get", "/v1/actors/{id}/threads"],
  ["get", "/v1/actors/{id}/threads/{thread}/events"],
  ["get", "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}"],
  ["get", "/v1/actors/{id}/threads/{thread}/projections/turns"],
  ["get", "/v1/actors/{id}/threads/{thread}/tree"],
  ["get", "/healthz"]
]

const operationsOf = (spec: { readonly paths: Record<string, Record<string, unknown>> }) =>
  Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => `${method} ${path}`)
  )

describe("the OpenAPI document", () => {
  test("lists every endpoint the declaration holds", () => {
    const listed = operationsOf(OpenApi.fromApi(ServerApi) as never)
    expect(listed.sort()).toEqual(ROUTES.map(([method, path]) => `${method} ${path}`).sort())
  })

  test("describes a failure as problem+json", () => {
    const spec = OpenApi.fromApi(ServerApi) as never as {
      readonly paths: Record<string, Record<string, { readonly responses: Record<string, {
        readonly content?: Record<string, unknown>
      }> }>>
    }
    const responses = spec.paths["/v1/actors/{id}/threads/{thread}/events"]!["get"]!.responses
    expect(Object.keys(responses).sort()).toEqual(["200", "400", "404"])
    expect(Object.keys(responses["404"]!.content!)).toEqual([PROBLEM_CONTENT_TYPE])
  })

  test("describes every cancellation resource outcome", () => {
    const spec = OpenApi.fromApi(ServerApi) as never as {
      readonly paths: Record<string, Record<string, { readonly responses: Record<string, unknown> }>>
    }
    const responses = spec.paths[
      "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}/cancellation"
    ]!["put"]!.responses
    expect(Object.keys(responses).sort()).toEqual(["200", "202", "400", "404", "409"])
  })

  test("is served where the constant says, and renders at the docs path", async () => {
    const answers = await serving({}, (client) =>
      Effect.gen(function*() {
        const document = yield* client.get(OPENAPI_PATH)
        const page = yield* client.get(DOCS_PATH)
        return {
          document: { status: document.status, body: yield* document.json },
          page: { status: page.status, type: page.headers["content-type"], body: yield* page.text }
        }
      }))
    expect(answers.document.status).toBe(200)
    expect(operationsOf(answers.document.body as never).sort()).toEqual(
      ROUTES.map(([method, path]) => `${method} ${path}`).sort()
    )
    expect(answers.page.status).toBe(200)
    expect(answers.page.type).toContain("text/html")
    expect(answers.page.body).toContain("Scalar")
    expect(answers.page.body).toContain("--scalar-background-1: #f3f0e4")
    expect(answers.page.body).toContain("IBM Plex Sans")
  })

  // Public process capabilities stay readable when a token closes actor state (http.ts, UNAUTHENTICATED_PATHS).
  test("keeps public routes open when a token closes actor state", async () => {
    const statuses = await serving({ token: "secret" }, (client) =>
      Effect.gen(function*() {
        const document = yield* client.get(OPENAPI_PATH)
        const page = yield* client.get(DOCS_PATH)
        const catalog = yield* client.get("/v1/models")
        const gated = yield* client.get("/v1/actors/main/threads")
        return [document.status, page.status, catalog.status, gated.status]
      }))
    expect(statuses).toEqual([200, 200, 503, 401])
  })
})

describe("problem documents", () => {
  // RFC 9457's four fields are what the voyager renders, so every failure carries all four rather
  // than whichever subset a schema default would leave (docs/how-to/server.md, "Endpoints").
  test("carry type, title, status, and detail", async () => {
    const failures = await serving({}, (client) =>
      Effect.gen(function*() {
        const unknownThread = yield* client.get("/v1/actors/main/threads/ghost/events")
        const unknownProjection = yield* client.get("/v1/actors/main/threads/ghost/projections/facts")
        const unknownTurn = yield* client.get("/v1/actors/main/threads/ghost/projections/turns?at=1")
        return [
          { status: unknownThread.status, type: unknownThread.headers["content-type"], body: yield* unknownThread.json },
          {
            status: unknownProjection.status,
            type: unknownProjection.headers["content-type"],
            body: yield* unknownProjection.json
          },
          { status: unknownTurn.status, type: unknownTurn.headers["content-type"], body: yield* unknownTurn.json }
        ]
      }))

    for (const failure of failures) {
      expect(failure.type).toContain(PROBLEM_CONTENT_TYPE)
      const body = failure.body as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"])
      expect(body["status"]).toBe(failure.status)
      expect(String(body["type"])).toStartWith("https://tardigrade.dev/problems/")
      expect(String(body["title"]).length).toBeGreaterThan(0)
      expect(String(body["detail"]).length).toBeGreaterThan(0)
    }
    expect(failures.map((failure) => failure.status)).toEqual([404, 404, 404])
    // An endpoint declaring several failures encodes the one the value names, so this absent
    // actor does not render as an absent thread or an invalid request (contract.ts, problemKind).
    expect(failures[2]!.body).toMatchObject({ title: "Unknown Actor" })
  })

  // A Schema in the declaration refusing input is a failure like any other, so it answers in the
  // same shape rather than as the empty 400 the framework renders by default (contract.ts,
  // layerRequestProblems).
  test("carry a refused request too, whichever part was refused", async () => {
    const refusals = await serving({}, (client) =>
      Effect.gen(function*() {
        const post = (path: string, body: unknown) =>
          client.post(path, { body: HttpBody.jsonUnsafe(body) })
        const repeated = yield* client.get("/v1/actors/main/threads/ghost/projections/turns?at=1&at=2")
        const notANumber = yield* client.get("/v1/actors/main/threads/ghost/events?after=soon")
        const negative = yield* client.get("/v1/actors/main/threads/ghost/events?limit=-1")
        const missingField = yield* post("/v1/actors/main/threads/ghost/events", { id: "m1" })
        const emptyType = yield* post("/v1/actors/main/threads/ghost/events", { type: "", id: "m1" })
        const notAnObject = yield* post("/v1/actors/main/threads/ghost/events", "hello")
        const invalidActor = yield* client.get("/v1/actors/tenant%3Awest/threads/ghost/events")
        return yield* Effect.forEach(
          [repeated, notANumber, negative, missingField, emptyType, notAnObject, invalidActor],
          (response) =>
            Effect.map(response.json, (body) => ({
              status: response.status,
              type: response.headers["content-type"],
              body: body as Record<string, unknown>
            }))
        )
      }))

    for (const refusal of refusals) {
      expect(refusal.status).toBe(400)
      expect(refusal.type).toContain(PROBLEM_CONTENT_TYPE)
      expect(Object.keys(refusal.body).sort()).toEqual(["detail", "status", "title", "type"])
      expect(refusal.body).toMatchObject({
        type: "https://tardigrade.dev/problems/invalid-request",
        title: "Invalid Request",
        status: 400
      })
    }
    const details = refusals.map((refusal) => String(refusal.body["detail"]))
    expect(details[0]).toBe("The query is not what this endpoint accepts. `at` is not a value it accepts.")
    expect(details[1]).toContain("`after` is not a value it accepts")
    expect(details[2]).toContain("`limit` is not a value it accepts")
    expect(details[3]).toBe("The request body is not what this endpoint accepts. `type` is missing.")
    expect(details[4]).toContain("`type` is not a value it accepts")
    expect(details[6]).toContain("`id` is not a value it accepts")
    // A body that is not an object at all names no field, so the sentence stops at the part.
    expect(details[5]).toBe("The request body is not what this endpoint accepts.")
  })
})
