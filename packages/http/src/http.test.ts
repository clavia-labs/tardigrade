import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"

import { Threads, type ActorThreads } from "./threads"
import { ALLOWED_HEADERS, serve, PROBLEM_CONTENT_TYPE, type Health } from "./http"
import type { ApiOptions } from "./api"
import { DriverGauge, layerGaugeResting } from "./driver-gauge"

// Every case here boots a real server on an ephemeral port, so it competes with every other task in
// a parallel gate run. Bun's default per-test budget is tuned for a pure function and times out
// under that load; this is the budget a boot actually needs. It stays tight on purpose: a case that
// wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// The HTTP surface against a real Bun server on an ephemeral port, so the assertions are about
// wire behavior rather than about the shape of a layer.

// The conventions these tests are about hold over any host, so the thread routes get one that owns
// nothing. The routes themselves are exercised against a real host in api.test.ts.
const layerThreadsEmpty = Layer.succeed(Threads)({
  methods: {},
  storage: { kind: "memory" },
  instances: Effect.succeed([]),
  ensure: () => Effect.succeed({ allocateRoot: () => Effect.die(new Error("unexpected allocation")), methods: {}, statusOf: () => "settled", storage: { kind: "memory" }, append: () => Effect.void, appendUnlessKeyPresent: () => Effect.succeed(false), events: () => Effect.succeed([]), eventsPage: () => Effect.succeed([]), awaitHead: () => Effect.never, actorEventsPage: () => Effect.succeed([]), actorThreads: Effect.succeed({ cursor: 0, threads: [] }), actorThread: () => Effect.never, awaitActorHead: () => Effect.never, list: Effect.succeed([]), settled: Effect.void }),
  instance: () => Effect.succeed(undefined as ActorThreads | undefined),
  append: () => Effect.void,
  appendUnlessKeyPresent: () => Effect.succeed(false),
  events: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
  settled: () => Effect.void
})

// Boots the application on port 0 and hands the body a client already pointed at it.
const serving = <A, E>(
  options: {
    readonly config?: { readonly token: string }
    readonly gauge?: Layer.Layer<DriverGauge>
    readonly api?: ApiOptions
    readonly threads?: Layer.Layer<Threads>
  },
  body: (client: HttpClient.HttpClient) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return yield* body(client)
  }).pipe(
    Effect.provide(
      Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true, api: { token: options.config?.token, ...options.api } }), [
        BunHttpServer.layerTest,
        options.gauge ?? layerGaugeResting,
        options.threads ?? layerThreadsEmpty
      ])
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

describe("healthz", () => {
  test("healthz reports the gauge", async () => {
    const body = await serving({}, (client) =>
      Effect.flatMap(client.get("/healthz"), (response) => response.json))
    expect(body).toEqual({ status: "resting", dirty: 0 } satisfies Health)
  })

  test("a driving host with owed threads reads through", async () => {
    const gauge = Layer.succeed(DriverGauge)({
      resting: Effect.succeed(false),
      dirty: Effect.succeed(3)
    })
    const body = await serving({ gauge }, (client) =>
      Effect.flatMap(client.get("/healthz"), (response) => response.json))
    expect(body).toEqual({ status: "driving", dirty: 3 } satisfies Health)
  })
})

describe("errors", () => {
  test("an unmatched route is a problem document", async () => {
    const response = await serving({}, (client) => client.get("/nope"))
    expect(response.status).toBe(404)
    expect(response.headers["content-type"]).toContain(PROBLEM_CONTENT_TYPE)
  })
})

describe("auth", () => {
  test("no token leaves every route open", async () => {
    const response = await serving({}, (client) => client.get("/nope"))
    expect(response.status).toBe(404)
  })

  test("a token closes the API and leaves healthz open", async () => {
    const config = { token: "secret" }

    const anonymous = await serving({ config }, (client) =>
      Effect.gen(function*() {
        const response = yield* client.get("/v1/actors/main/threads")
        return { status: response.status, contentType: response.headers["content-type"], body: yield* response.json }
      }))
    expect(anonymous.status).toBe(401)
    expect(anonymous.contentType).toContain(PROBLEM_CONTENT_TYPE)
    expect(anonymous.body).toMatchObject({ status: 401, title: "Unauthorized" })

    const wrong = await serving({ config }, (client) =>
      client.execute(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/definitions"), "guess")))
    expect(wrong.status).toBe(403)

    const right = await serving({ config }, (client) =>
      client.execute(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/definitions"), "secret")))
    expect(right.status).toBe(200)

    const health = await serving({ config }, (client) => client.get("/healthz"))
    expect(health.status).toBe(200)
    const models = await serving({ config }, (client) => client.get("/v1/models"))
    expect(models.status).toBe(503)
  })
})

describe("cors", () => {
  test("the preflight allows what the client sends", async () => {
    // A browser asks before it sends, and it sends what the derived client puts on a request: the
    // bearer token, the body's content type, and the span the HTTP client propagates
    // (packages/client/src/client.ts). A header missing from the answer is a call the browser never
    // makes.
    const allowed = await serving({}, (client) =>
      Effect.map(
        client.execute(
          HttpClientRequest.setHeaders(HttpClientRequest.options("/v1/actors/main/threads"), {
            origin: "http://localhost:5173",
            "access-control-request-method": "GET",
            "access-control-request-headers": ALLOWED_HEADERS.join(",")
          })
        ),
        (response) => response.headers["access-control-allow-headers"] ?? ""
      ))
    const stated = allowed.toLowerCase()
    for (const header of ALLOWED_HEADERS) expect(stated).toContain(header)
  })
})


test("runtime metadata uses the backend storage description", async () => {
  const metadata = await serving({}, (client) =>
    Effect.flatMap(client.get("/v1/metadata"), (response) => response.json))
  expect(metadata).toMatchObject({ storage: { kind: "memory" } })
})

test("generic HTTP does not install agent projections", async () => {
  const response = await serving({}, (client) =>
    Effect.flatMap(client.get("/v1/actors/main/threads/root/projections/turns"), (response) =>
      Effect.map(response.json, (body) => ({ status: response.status, body }))))
  expect(response.status).toBe(404)
  expect(response.body).toMatchObject({ detail: expect.stringContaining("This actor declares no projections.") })
})


test("custom log projections remain explicitly configurable", async () => {
  const projections = { count: { params: {}, result: Schema.Finite, run: (events: ReadonlyArray<unknown>) => events.length } }
  const threads = Layer.effect(Threads)(Effect.map(Threads, (service) => ({
    ...service,
    instance: () => Effect.map(service.ensure("main"), (actor) => ({
      ...actor,
      events: () => Effect.succeed([{ type: "CustomEvent" }])
    }))
  }))).pipe(Layer.provide(layerThreadsEmpty))
  const result = await serving({ api: { projections }, threads }, (client) =>
    Effect.gen(function* () {
      const response = yield* client.get("/v1/actors/main/threads/root/projections/count")
      const count = yield* response.json
      const spec = yield* Effect.flatMap(client.get("/openapi.json"), (response) => response.json)
      return { count, spec }
    }))
  expect(result.count).toBe(1)
  expect(result.spec).toMatchObject({ paths: { "/v1/actors/{id}/threads/{thread}/projections/count": expect.anything() } })
})
