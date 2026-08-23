import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"

import {
  DEFAULT_ACTORS,
  DEFAULT_ACTOR_DATA,
  DEFAULT_DB,
  DEFAULT_MAX_CONCURRENT_LANES,
  DEFAULT_PORT,
  layerConfig,
  readConfig,
  type ServerConfigValue
} from "./config"
import { Threads } from "./host"
import { ALLOWED_HEADERS, layerGaugeResting, serve, PROBLEM_CONTENT_TYPE, DriverGauge, type Health } from "./http"

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
  append: () => Effect.void,
  events: () => Effect.succeed([]),
  list: Effect.succeed([]),
  settled: Effect.void
})

const configOf = (overrides: Partial<ServerConfigValue> = {}): ServerConfigValue => ({
  ...readConfig({}),
  ...overrides
})

// Boots the application on port 0 and hands the body a client already pointed at it.
const serving = <A, E>(
  options: {
    readonly config?: ServerConfigValue
    readonly gauge?: Layer.Layer<DriverGauge>
  },
  body: (client: HttpClient.HttpClient) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    return yield* body(client)
  }).pipe(
    Effect.provide(
      Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true }), [
        BunHttpServer.layerTest,
        layerConfig(options.config ?? configOf()),
        options.gauge ?? layerGaugeResting,
        layerThreadsEmpty
      ])
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

describe("config", () => {
  test("defaults are the exported constants", () => {
    const config = readConfig({})
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.db).toBe(DEFAULT_DB)
    expect(config.actors).toBe(DEFAULT_ACTORS)
    expect(config.actorData).toBe(DEFAULT_ACTOR_DATA)
    expect(config.maxConcurrentLanes).toBe(DEFAULT_MAX_CONCURRENT_LANES)
    expect(config.token).toBeUndefined()
    expect(config.model).toEqual({
      default: undefined,
      connections: {}
    })
  })

  test("the environment overrides every default", () => {
    const config = readConfig({
      PORT: "8080",
      TARDIGRADE_DB: "/var/lib/agents.sqlite",
      TARDIGRADE_ACTORS: "/var/lib/actors",
      TARDIGRADE_ACTOR_DATA: "/var/lib/actor-data",
      TARDIGRADE_MAX_CONCURRENT_LANES: "7",
      TARDIGRADE_TOKEN: "secret",
      MODEL_BASE_URL: "https://api.example.com",
      MODEL_API_KEY: "key",
      MODEL_ID: "a-model",
      MODEL_DRIVER: "openai-responses",
      MODEL_CONTEXT_WINDOW_TOKENS: "1050000",
      MODEL_MAX_OUTPUT_TOKENS: "128000",
      MODEL_PROVIDER: "openai"
    })
    expect(config.port).toBe(8080)
    expect(config.db).toBe("/var/lib/agents.sqlite")
    expect(config.actors).toBe("/var/lib/actors")
    expect(config.actorData).toBe("/var/lib/actor-data")
    expect(config.maxConcurrentLanes).toBe(7)
    expect(config.token).toBe("secret")
    expect(config.model.default).toEqual({ id: "a-model", connection: "environment" })
    const connection = config.model.connections["environment"]!
    expect(connection.baseUrl).toBe("https://api.example.com")
    expect(connection.provider).toBe("openai")
    expect(connection.driver).toBe("openai-responses")
    expect(connection.models["a-model"]?.contextWindowTokens).toBe(1_050_000)
    expect(connection.models["a-model"]?.maxOutputTokens).toBe(128_000)
  })

  // Listening somewhere other than where the operator asked is worse than refusing to start.
  test("a PORT that is not a port refuses to resolve", () => {
    expect(() => readConfig({ PORT: "http" })).toThrow()
    expect(() => readConfig({ PORT: "70000" })).toThrow()
  })

  test("a concurrency cap that cannot schedule a lane refuses to resolve", () => {
    expect(() => readConfig({ TARDIGRADE_MAX_CONCURRENT_LANES: "0" })).toThrow("positive integer")
    expect(() => readConfig({ TARDIGRADE_MAX_CONCURRENT_LANES: "many" })).toThrow("positive integer")
  })
})

describe("healthz", () => {
  test("healthz reports the gauge", async () => {
    const body = await serving({}, (client) =>
      Effect.flatMap(client.get("/healthz"), (response) => response.json))
    expect(body).toEqual({ status: "resting", dirty: 0 } satisfies Health)
  })

  test("a driving host with owed lanes reads through", async () => {
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
    const config = configOf({ token: "secret" })

    const anonymous = await serving({ config }, (client) =>
      Effect.gen(function*() {
        const response = yield* client.get("/v1/actors/default/threads")
        return { status: response.status, contentType: response.headers["content-type"], body: yield* response.json }
      }))
    expect(anonymous.status).toBe(401)
    expect(anonymous.contentType).toContain(PROBLEM_CONTENT_TYPE)
    expect(anonymous.body).toMatchObject({ status: 401, title: "Unauthorized" })

    const wrong = await serving({ config }, (client) =>
      client.execute(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/actors/default/threads"), "guess")))
    expect(wrong.status).toBe(403)

    const right = await serving({ config }, (client) =>
      client.execute(HttpClientRequest.bearerToken(HttpClientRequest.get("/v1/actors/default/threads"), "secret")))
    expect(right.status).toBe(200)

    const health = await serving({ config }, (client) => client.get("/healthz"))
    expect(health.status).toBe(200)
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
          HttpClientRequest.setHeaders(HttpClientRequest.options("/v1/actors/default/threads"), {
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
