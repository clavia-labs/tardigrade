import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Duration, Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ThreadEventRow } from "@clavia/tardigrade-core/log"
import { Ingress } from "@clavia/tardigrade-host/communication/ingress"
import { ACTOR_ARTIFACT_VERSION, Infer, type InferRequest } from "tardie"
import type { Action } from "tardie/log/events"

import { openStreams } from "./api"
import { layerModelCatalogValue } from "./catalog"
import { layerConfig, readConfig } from "./config"
import { PROBLEM_TYPE_BASE, type EventRow, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import { layerThreads, Threads, type ActorThreads } from "./host"
import { PROBLEM_CONTENT_TYPE, serve } from "./http"
import { layerGaugeResting } from "./driver-gauge"
import type { TurnViewShape as TurnView } from "./actor"
import type { ThreadSummary, ThreadNode } from "./projections"

// Every case here boots a real server on an ephemeral port, so it competes with every other task in
// a parallel gate run. Bun's default per-test budget is tuned for a pure function and times out
// under that load; this is the budget a boot actually needs. It stays tight on purpose: a case that
// wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// The API over a real Bun server on an ephemeral port, over a real durable host on a volatile
// database, with the model seam bound to a scripted mind: every assertion here is about what a
// client sees on the wire, and the only thing that is not real is the model (host.ts, ThreadsOptions).

const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String((event as { text?: unknown }).text ?? "")
  }
  return ""
}

// The scripted mind answers in one attempt, except on a brief that asks it to spawn: there it runs
// one execution that briefs a child and answers with the child's answer, which is the shape the
// library's own spawn test drives (packages/agent/src/index.test.ts, the scripted mind). The tool
// call id is derived from the brief, so the child's id is stated by the test rather than by a
// counter (packages/agent/src/packages/agents.ts, `sibling`).
const scripted = ({ trajectory }: InferRequest): Action => {
  const brief = briefOf(trajectory)
  if (!brief.startsWith("spawn ")) return { kind: "complete", output: `ok: ${brief}` }
  const start = trajectory.reduce((n, event, i) => (event.type === "MessageReceived" ? i : n), 0)
  const returned = trajectory.slice(start).find((event) => event.type === "ToolReturned") as
    | { result?: { result?: unknown } }
    | undefined
  if (returned !== undefined) return { kind: "complete", output: JSON.stringify(returned.result?.result ?? null) }
  return {
    kind: "call",
    callId: brief.slice("spawn ".length),
    name: "execute",
    arguments: { code: `const a = await agents.run({ text: "hello child" }); return a.output;` }
  }
}

const testModel = { provider: "openai", model_id: "gpt-mini" } as const

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  resolve: (model = testModel) => ({ model, models: { default: model, allow: "*" } }),
  react: (request: InferRequest) => Effect.succeed(scripted(request))
})

const config = layerConfig(readConfig({
  TARDIGRADE_DB: ":memory:",
  TARDIGRADE_ACTORS: `/tmp/tardigrade-api-test-${process.pid}`,
  OPENAI_API_KEY: "test-key"
}, {
  models: {
    default: { provider: "openai", model_id: "gpt-mini" },
    allow: "*",
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        protocol: "openai-responses",
        env: ["OPENAI_API_KEY"]
      }
    }
  }
}))

const catalog: ModelCatalog = {
  source: "models.dev",
  revision: "catalog-1",
  refreshedAt: 1_700_000_000_000,
  status: "fresh",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: [
        { id: "gpt-mini", metadata: { contextWindowTokens: 64_000, pricing: { promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_004 } } },
        { id: "gpt-test", metadata: { contextWindowTokens: 128_000, pricing: { promptUsdPerToken: 0.000_002, completionUsdPerToken: 0.000_003 } } }
      ]
    },
    {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: [{ id: "claude-test", metadata: { contextWindowTokens: 200_000 } }]
    }
  ]
}
const catalogLayer = layerModelCatalogValue(catalog)

const app = Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true }), [
  BunHttpServer.layer({ port: 0 }),
  config,
  catalogLayer,
  Layer.provide(layerThreads({ infer: layerScripted }), [config, catalogLayer])
])

// Boots the process and hands the body its base URL. The body is plain fetch, because a client of
// this API is plain fetch.
const serving = <A>(body: (base: string) => Promise<A>): Promise<A> =>
  Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    const port = address._tag === "TcpAddress" ? address.port : 0
    return yield* Effect.promise(() => body(`http://127.0.0.1:${port}`))
  }).pipe(Effect.provide(app), Effect.scoped, Effect.runPromise) as Promise<A>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// until polls a question the server answers asynchronously, which is how a client waits for an
// outcome: the server drives continuously and never takes a wait (apps-server-spec.md,
// "Principles").
const until = async <A>(what: string, poll: () => Promise<A | undefined>, ms = 10_000): Promise<A> => {
  const deadline = Date.now() + ms
  for (;;) {
    const answer = await poll()
    if (answer !== undefined) return answer
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

const get = (base: string, path: string) => fetch(`${base}${path}`)

const post = (base: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

const put = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

// turnOf reads one turn through the actor's declared projection, narrowed by its `turn` query.
// There is no route that reads a turn by id: the single lookup is this query (actor.ts,
// agentProjections).
const turnOf = async (base: string, thread: string, turn: string): Promise<TurnView | undefined> => {
  const views = (await (await fetch(
    `${base}/v1/actors/main/threads/${thread}/projections/turns?turn=${encodeURIComponent(turn)}`
  )).json()) as ReadonlyArray<TurnView>
  return views[0]
}

const birth = async (base: string, id: string, message: { id: string; text: string }) => {
  const response = await post(base, `/v1/actors/main/threads/${id}/events`, {
    type: "MessageReceived",
    ...message
  })
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ actor: "main", thread: id })
  return until(`turn ${message.id} of ${id}`, async () => {
    const view = await turnOf(base, id, message.id)
    return view === undefined || view.status === "pending" ? undefined : view
  })
}

const callMessage = async (base: string, thread: string, call: string, text: string) => {
  const response = await put(
    base,
    `/v1/actors/main/threads/${thread}/methods/message/calls/${call}`,
    { text }
  )
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({
    actor: "main",
    thread,
    method: "message",
    call,
    deadlineAt: expect.any(Number)
  })
  return until(`method call ${call} of ${thread}`, async () => {
    const state = await get(base, `/v1/actors/main/threads/${thread}/methods/message/calls/${call}`)
    const body = await state.json() as Record<string, unknown>
    return body["status"] === "pending" ? undefined : body
  })
}

describe("models", () => {
  test("the public catalog pages model metadata without credentials", async () => {
    const first = await serving(async (base) => await (await get(base, "/v1/models?provider=openai&limit=1")).json()) as {
      readonly items: ReadonlyArray<{ readonly id: string }>
      readonly policy: unknown
      readonly next_cursor?: string
      readonly limit: number
      readonly total: number
    }
    expect(first).toMatchObject({ limit: 1, total: 2, items: [{ id: "gpt-mini" }] })
    expect(first.policy).toEqual({
      default: { provider: "openai", model_id: "gpt-mini" },
      allow: "*"
    })
    expect(typeof first.next_cursor).toBe("string")
    const second = await serving(async (base) => await (await get(
      base,
      `/v1/models?provider=openai&limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`
    )).json())
    expect(second).toMatchObject({ items: [{ id: "gpt-test" }] })
    expect(JSON.stringify([first, second])).not.toContain("apiKey")
  })

  test("provider discovery states connection requirements", async () => {
    const response = await serving(async (base) => await (await get(base, "/v1/providers?search=openai")).json())
    expect(response).toMatchObject({
      revision: "catalog-1",
      items: [{
        id: "openai",
        availability: { status: "available" },
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        env: ["OPENAI_API_KEY"],
        required: ["env"]
      }]
    })
  })

  test("provider discovery reports configuration availability", async () => {
    const response = await serving(async (base) => await (await get(base, "/v1/providers?search=anthropic")).json())
    expect(response).toMatchObject({
      items: [{
        id: "anthropic",
        availability: { status: "unavailable", reason: "not_configured" }
      }]
    })
  })

  test("the model route sorts by the selected price", async () => {
    const page = await serving(async (base) => await (await get(
      base,
      "/v1/models?sort=completionUsdPerToken&order=asc"
    )).json()) as { readonly items: ReadonlyArray<{ readonly id: string }> }
    expect(page.items.map((model) => model.id)).toEqual(["gpt-test", "gpt-mini", "claude-test"])
  })

  test("the host model route includes unconfigured catalog providers", async () => {
    const page = await serving(async (base) => await (await get(base, "/v1/models?search=claude-test")).json()) as {
      readonly items: ReadonlyArray<{ readonly provider: string; readonly id: string; readonly metadata: unknown }>
    }
    expect(page.items).toEqual([{ provider: "anthropic", id: "claude-test", metadata: { contextWindowTokens: 200_000 } }])
  })

  test("the host model route exposes its available view", async () => {
    const page = await serving(async (base) => await (await get(base, "/v1/models?availability=available")).json()) as {
      readonly items: ReadonlyArray<{ readonly provider: string }>
    }
    expect(page.items.map((model) => model.provider)).toEqual(["openai", "openai"])
  })

  test("a cursor cannot change its query", async () => {
    const first = await serving(async (base) => await (await get(base, "/v1/models?limit=1")).json()) as {
      readonly next_cursor: string
    }
    const response = await serving(async (base) => await get(
      base,
      `/v1/models?limit=1&search=gpt&cursor=${encodeURIComponent(first.next_cursor)}`
    ))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ title: "Invalid Request", status: 400 })
  })
})

describe("actor methods", () => {
  test("the actor exposes its method schemas", async () => {
    const methods = await serving(async (base) =>
      await (await get(base, "/v1/methods")).json() as ReadonlyArray<{
        readonly name: string
        readonly cancellable: boolean
        readonly timeoutMs: number
        readonly inputSchema: { readonly $ref?: unknown; readonly $defs?: Record<string, { readonly properties?: Record<string, unknown> }> }
        readonly outputSchema: { readonly type?: unknown }
      }>)
    expect(methods.map((method) => method.name)).toEqual(["message", "requestBudget"])
    const message = methods.find((method) => method.name === "message")
    const budget = methods.find((method) => method.name === "requestBudget")
    expect(message?.cancellable).toBe(true)
    expect(message?.timeoutMs).toBe(300_000)
    expect(budget?.cancellable).toBe(false)
    expect(message?.inputSchema.$ref).toBe("#/$defs/AgentMessageInput")
    expect(message?.inputSchema.$defs?.["AgentMessageInput"]).toMatchObject({
      type: "object",
      required: ["text"],
      properties: {
        model: {
          type: "object",
          required: ["provider", "model_id"],
          properties: {
            provider: { type: "string" },
            model_id: { type: "string" }
          }
        }
      }
    })
    expect(message?.outputSchema).toMatchObject({ type: "string" })
    expect(budget?.inputSchema.$ref).toBe("#/$defs/BudgetRequestInput")
  })

  test("an invocation births a thread and exposes its completed state", async () => {
    const result = await serving(async (base) => {
      const response = await put(base, "/v1/actors/main/threads/alpha/methods/message/calls/m1", {
        text: "hello",
        model: { provider: "openai", model_id: "gpt-test" }
      })
      expect(response.status).toBe(202)
      const state = await until("method call m1 of alpha", async () => {
        const current = await get(base, "/v1/actors/main/threads/alpha/methods/message/calls/m1")
        const body = await current.json() as Record<string, unknown>
        return body["status"] === "pending" ? undefined : body
      })
      const events = await (await get(base, "/v1/actors/main/threads/alpha/events")).json() as ReadonlyArray<EventRow>
      return { state, events }
    })
    expect(result.state).toEqual({ status: "completed", output: "ok: hello" })
    expect(result.events.find((row) => row.event.type === "MessageReceived")?.event).toMatchObject({
      model: { provider: "openai", model_id: "gpt-test" }
    })
  })

  test("putting the same call URL is absorbed", async () => {
    const read = await serving(async (base) => {
      await callMessage(base, "alpha", "m1", "hello")
      const eventsAt = async () => await (await get(base, "/v1/actors/main/threads/alpha/events")).json() as ReadonlyArray<EventRow>
      const before = await eventsAt()
      const repeated = await put(base, "/v1/actors/main/threads/alpha/methods/message/calls/m1", { text: "different" })
      const after = await eventsAt()
      const state = await get(base, "/v1/actors/main/threads/alpha/methods/message/calls/m1")
      return { repeated: { status: repeated.status, body: await repeated.json() }, before, after, state: await state.json() }
    })
    expect(read.repeated.status).toBe(202)
    expect(read.repeated.body).toMatchObject({
      actor: "main",
      thread: "alpha",
      method: "message",
      call: "m1",
      deadlineAt: expect.any(Number)
    })
    expect(read.after).toEqual(read.before)
    expect(read.state).toEqual({ status: "completed", output: "ok: hello" })
  })

  test("an invocation exposes and honors its selected timeout", async () => {
    const result = await serving(async (base) => {
      const response = await put(
        base,
        "/v1/actors/main/threads/alpha/methods/message/calls/m1?timeoutMs=25",
        { text: "hello" }
      )
      const accepted = await response.json() as { readonly deadlineAt: number }
      const events = await (await get(base, "/v1/actors/main/threads/alpha/events")).json() as ReadonlyArray<EventRow>
      const message = events.find((row) => row.event.type === "MessageReceived")?.event as { readonly at?: number } | undefined
      return { status: response.status, accepted, message }
    })
    expect(result.status).toBe(202)
    expect(result.accepted.deadlineAt - result.message!.at!).toBe(25)
  })

  test("cancelling a settled invocation returns a conflict", async () => {
    const result = await serving(async (base) => {
      await callMessage(base, "alpha", "m1", "hello")
      const path = "/v1/actors/main/threads/alpha/methods/message/calls/m1/cancellation"
      const first = await put(base, path, { reason: "operator stopped it" })
      const second = await put(base, path, { reason: "another caller stopped it" })
      const rows = await (await get(base, "/v1/actors/main/threads/alpha/events")).json() as ReadonlyArray<EventRow>
      return {
        first: { status: first.status, body: await first.json() },
        second: { status: second.status, body: await second.json() },
        events: rows.filter((row) => row.event.type === "CancellationRequested")
      }
    })
    expect(result.first).toEqual({
      status: 409,
      body: {
        type: "https://tardigrade.dev/problems/invocation-settled",
        title: "Invocation Settled",
        status: 409,
        detail: "Invocation \"m1\" has settled and cannot be cancelled."
      }
    })
    expect(result.second).toEqual({
      status: 409,
      body: {
        type: "https://tardigrade.dev/problems/invocation-settled",
        title: "Invocation Settled",
        status: 409,
        detail: "Invocation \"m1\" has settled and cannot be cancelled."
      }
    })
    expect(result.events).toHaveLength(0)
  })

  test("a method without cancellation refuses the control request", async () => {
    const refusal = await serving(async (base) => {
      const invoked = await put(
        base,
        "/v1/actors/main/threads/alpha/methods/requestBudget/calls/b1",
        { request: "budget-1", turn: "m1", reason: "more work", amount: 1 }
      )
      expect(invoked.status).toBe(202)
      const response = await put(
        base,
        "/v1/actors/main/threads/alpha/methods/requestBudget/calls/b1/cancellation",
        {}
      )
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
    expect(refusal.status).toBe(400)
    expect(refusal.body).toMatchObject({ title: "Invalid Request", status: 400 })
    expect(String(refusal.body["detail"])).toContain("does not declare cancellation")
  })

  test("an invalid input is refused before it reaches the log", async () => {
    const refusal = await serving(async (base) => {
      const response = await put(base, "/v1/actors/main/threads/alpha/methods/message/calls/m1", {})
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
    expect(refusal.status).toBe(400)
    expect(refusal.body).toMatchObject({ title: "Invalid Request", status: 400 })
    expect(String(refusal.body["detail"])).toContain("message")
    expect(String(refusal.body["detail"])).toContain("text")
  })

  test("an unknown method names the methods the actor declares", async () => {
    const refusal = await serving(async (base) => {
      const response = await put(base, "/v1/actors/main/threads/alpha/methods/missing/calls/m1", {})
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
    expect(refusal.status).toBe(404)
    expect(refusal.body).toMatchObject({ title: "Unknown Method", status: 404 })
    expect(String(refusal.body["detail"])).toContain('"message"')
  })

  test("a call the method cannot derive is its own 404", async () => {
    const refusal = await serving(async (base) => {
      await callMessage(base, "alpha", "m1", "hello")
      const response = await get(base, "/v1/actors/main/threads/alpha/methods/message/calls/missing")
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
    expect(refusal.status).toBe(404)
    expect(refusal.body).toMatchObject({ title: "Unknown Method Call", status: 404 })
  })
})

describe("appending", () => {
  test("an appended message births a thread and the server drives its turn to completed", async () => {
    const view = await serving((base) => birth(base, "alpha", { id: "m1", text: "hello" }))
    expect(view).toEqual({ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" })
  })

  // `type` is the only field the platform requires, because an event is one fact and what its
  // other fields mean is the actor's knowledge (contract.ts, Append).
  test("a body with no type is refused", async () => {
    const problems = await serving(async (base) => {
      const noType = await post(base, "/v1/actors/main/threads/alpha/events", { id: "m1", text: "hello" })
      const emptyType = await post(base, "/v1/actors/main/threads/alpha/events", { type: "" })
      return [
        { status: noType.status, type: noType.headers.get("content-type"), body: await noType.json() },
        { status: emptyType.status, type: emptyType.headers.get("content-type"), body: await emptyType.json() }
      ]
    })
    for (const refused of problems) {
      expect(refused.status).toBe(400)
      expect(refused.type).toContain(PROBLEM_CONTENT_TYPE)
      expect(refused.body).toMatchObject({ status: 400, title: "Invalid Request" })
    }
    expect((problems[0]!.body as { detail: string }).detail).toContain("`type` is missing")
    expect((problems[1]!.body as { detail: string }).detail).toContain("`type` is not a value it accepts")
  })

  // Duplicate suppression is the actor's, keyed by its own `keyOf` (packages/core/src/communication/message.ts,
  // messageKeys), so the platform appends and the assembly decides what a repeat means.
  test("a redelivered message id answers the same and writes nothing", async () => {
    const counts = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const before = ((await (await fetch(`${base}/v1/actors/main/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      const again = await post(base, "/v1/actors/main/threads/alpha/events", {
        type: "MessageReceived",
        id: "m1",
        text: "hello"
      })
      expect(again.status).toBe(202)
      expect(await again.json()).toEqual({ actor: "main", thread: "alpha" })
      await sleep(50)
      const after = ((await (await fetch(`${base}/v1/actors/main/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>).length
      return [before, after]
    })
    expect(counts[1]).toBe(counts[0]!)
  })
})

describe("actors", () => {
  test("a pushed actor is discovered by the control plane", async () => {
    const root = await mkdtemp(join(tmpdir(), "tardigrade-actors-"))
    const actorData = await mkdtemp(join(tmpdir(), "tardigrade-actor-data-"))
    const isolatedConfig = layerConfig(readConfig({
      TARDIGRADE_DB: ":memory:",
      TARDIGRADE_ACTORS: root,
      TARDIGRADE_ACTOR_DATA: actorData
    }))
    const isolatedCatalog = layerModelCatalogValue(catalog)
    const isolatedApp = Layer.provideMerge(serve({ disableLogger: true, disableListenLog: true }), [
      BunHttpServer.layer({ port: 0 }),
      isolatedConfig,
      isolatedCatalog,
      Layer.provide(layerThreads({ infer: layerScripted }), [isolatedConfig, isolatedCatalog])
    ])
    const module = `export default { name: "reviewer", methods: {}, components: [], projections: [], keyOf: () => undefined }\n`
    const digest = `sha256:${createHash("sha256").update(module).digest("hex")}`
    try {
      const result = await Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        const address = server.address
        const port = address._tag === "TcpAddress" ? address.port : 0
        const base = `http://127.0.0.1:${port}`
        return yield* Effect.promise(async () => {
          const incompatible = await put(base, "/v1/definitions", {
            manifest: { schema: 3, name: "reviewer", module: "actor.mjs", digest },
            module
          })
          const pushed = await put(base, "/v1/definitions", {
            manifest: { schema: ACTOR_ARTIFACT_VERSION, name: "reviewer", module: "actor.mjs", digest },
            module
          })
          const summary = await pushed.json()
          const actors = await (await get(base, "/v1/definitions")).json()
          return {
            incompatible: { status: incompatible.status, body: await incompatible.json() },
            pushStatus: pushed.status,
            summary,
            actors
          }
        })
      }).pipe(Effect.provide(isolatedApp), Effect.scoped, Effect.runPromise)
      expect(result.incompatible.status).toBe(400)
      expect(result.incompatible.body).toMatchObject({ status: 400, title: "Invalid Request" })
      expect((result.incompatible.body as { detail: string }).detail).toContain("`manifest.schema`")
      expect(result.pushStatus).toBe(200)
      expect(result.summary).toEqual({ name: "reviewer", builtIn: false, digest })
      expect(result.actors).toContainEqual({ name: "reviewer", builtIn: false, digest })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(actorData, { recursive: true, force: true })
    }
  })
})

describe("the listing", () => {
  test("a thread that has settled lists as settled", async () => {
    const listed = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      return (await (await fetch(`${base}/v1/actors/main/threads`)).json()) as ReadonlyArray<ThreadSummary>
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: "alpha", status: "settled", depth: 0 })
    expect(listed[0]!.events).toBeGreaterThan(0)
    expect(listed[0]!.parent).toBeUndefined()
  })
})

describe("events", () => {
  test("after and limit page the log, and types filters without renumbering it", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<EventRow>
      const all = await json("/v1/actors/main/threads/alpha/events")
      return {
        all,
        page: await json("/v1/actors/main/threads/alpha/events?after=1&limit=2"),
        completed: await json("/v1/actors/main/threads/alpha/events?types=TurnCompleted"),
        both: await json(`/v1/actors/main/threads/alpha/events?after=1&types=MessageReceived,TurnCompleted`),
        empty: await json("/v1/actors/main/threads/alpha/events?types=NothingLikeThis")
      }
    })
    expect(read.all.map((row) => row.seq)).toEqual(read.all.map((_, i) => i + 1))
    expect(read.page.map((row) => row.seq)).toEqual([2, 3])
    expect(read.page.map((row) => row.event)).toEqual(read.all.slice(1, 3).map((row) => row.event))
    // The filtered row keeps the seq it has in the whole log, so `after` means the same place with
    // a filter as without one.
    expect(read.completed).toHaveLength(1)
    const completed = read.all.find((row) => row.event.type === "TurnCompleted")!
    expect(read.completed[0]!.seq).toBe(completed.seq)
    expect(read.both.every((row) => row.seq > 1)).toBe(true)
    // An existing thread's filtered empty page is a page, not a 404.
    expect(read.empty).toEqual([])
  })

  test("a log that never existed is the only 404", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      await put(base, "/v1/actors/main", {})
      const missing = await fetch(`${base}/v1/actors/main/threads/ghost/events`)
      return { status: missing.status, type: missing.headers.get("content-type"), body: await missing.json() }
    })
    expect(answers.status).toBe(404)
    expect(answers.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.body).toMatchObject({ status: 404, title: "Unknown Thread" })
  })
})

// framesOf parses an SSE byte stream into the pairs a client acts on. It is deliberately literal:
// the assertions below are about the wire format, so nothing here normalizes it.
const framesOf = (text: string): ReadonlyArray<{ readonly id: string; readonly data: string }> =>
  text
    .split("\n\n")
    .filter((frame) => frame.startsWith("id:"))
    .map((frame) => {
      const lines = frame.split("\n")
      return {
        id: lines.find((line) => line.startsWith("id:"))!.slice(3).trim(),
        data: lines.find((line) => line.startsWith("data:"))!.slice(5).trim()
      }
    })

describe("the event stream", () => {
  test("an idle tail reads again only after its committed head advances", async () => {
    let pageReads = 0
    let head = 1
    let rows: ReadonlyArray<ThreadEventRow> = [{
      seq: 1,
      event: { type: "ThreadCreated", actor: "test", instance: "main", thread: "alpha", depth: 0, at: 0 } as Event
    }]
    const waiters = new Set<(head: number) => void>()
    const actorThreads: ActorThreads = {
      methods: {},
      sqlite: ":memory:",
      append: () => Effect.void,
      events: () => Effect.succeed(rows.map((row) => row.event)),
      eventsPage: (_id, mark, limit) => Effect.sync(() => {
        pageReads += 1
        return rows.filter((row) => row.seq > mark).slice(0, limit)
      }),
      awaitHead: (_id, mark) => head > mark ? Effect.succeed(head) : Effect.callback<number>((resume) => {
        const wake = (head: number) => {
          waiters.delete(wake)
          resume(Effect.succeed(head))
        }
        waiters.add(wake)
        return Effect.sync(() => { waiters.delete(wake) })
      }),
      actorEventsPage: () => Effect.succeed([]),
      actorThreads: Effect.succeed({ cursor: 0, threads: [] }),
      actorThread: () => Effect.never,
      awaitActorHead: () => Effect.never,
      list: Effect.succeed([]),
      settled: Effect.void
    }
    const threads = Layer.succeed(Threads)({
      methods: {},
      sqlite: ":memory:",
      actorName: "test",
      instances: Effect.succeed([{ id: "main", definition: "test" }]),
      ensure: () => Effect.succeed(actorThreads),
      instance: (id) => Effect.succeed(id === "main" ? actorThreads : undefined),
      append: () => Effect.void,
      events: () => Effect.succeed(rows.map((row) => row.event)),
      list: () => Effect.succeed([]),
      settled: () => Effect.void
    })
    const ingress = Layer.succeed(Ingress)({ commit: () => Effect.void, schedule: () => Effect.void })
    const testApp = Layer.provideMerge(serve({
      disableLogger: true,
      disableListenLog: true,
      api: { heartbeat: Duration.millis(10) }
    }), [BunHttpServer.layer({ port: 0 }), config, catalogLayer, threads, ingress, layerGaugeResting])

    const verify = async (port: number) => {
      const abort = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/v1/actors/main/threads/alpha/events/stream?after=1`, {
        signal: abort.signal
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ""
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          text += decoder.decode(chunk.value, { stream: true })
        }
      })().catch(() => undefined)

      try {
        await until("the idle follower", async () => waiters.size === 1 ? true : undefined)
        const idleReads = pageReads
        await sleep(80)
        expect(pageReads).toBe(idleReads)

        rows = [...rows, { seq: 2, event: { type: "MessageReceived", id: "live", at: 1 } as Event }]
        head = 2
        waiters.forEach((wake) => { queueMicrotask(() => wake(2)) })
        await until("the pushed frame", async () => framesOf(text).some((frame) => frame.id === "2") ? true : undefined)
        expect(pageReads).toBe(idleReads + 1)
      } finally {
        abort.abort()
        await reader.cancel().catch(() => undefined)
        await pump
      }
      await until("the pushed tail to close", async () => waiters.size === 0 ? true : undefined)
    }

    await Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      const port = address._tag === "TcpAddress" ? address.port : 0
      yield* Effect.promise(() => verify(port))
    }).pipe(Effect.provide(testApp), Effect.scoped, Effect.runPromise)
  })

  test("a reconnect replays from Last-Event-ID and then runs live, once each", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const before = (await (await fetch(`${base}/v1/actors/main/threads/alpha/events`)).json()) as ReadonlyArray<EventRow>
      const abort = new AbortController()
      const response = await fetch(`${base}/v1/actors/main/threads/alpha/events/stream?after=0`, {
        // The header wins over the query, which is the whole of what a resuming EventSource can
        // state: it replays the URL it was opened with and carries the id in the header.
        headers: { "last-event-id": "2" },
        signal: abort.signal
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let text = ""
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          text += decoder.decode(chunk.value, { stream: true })
        }
      })().catch(() => undefined)

      // The backlog past the resumed id arrives first.
      await until("the replayed backlog", async () => (framesOf(text).length >= before.length - 2 ? true : undefined))
      const replayed = framesOf(text)
      expect(openStreams()).toBe(1)

      // Then a message delivered while the stream is open arrives on it.
      await post(base, "/v1/actors/main/threads/alpha/events", { type: "MessageReceived", id: "m2", text: "again" })
      await until("the live frames", async () => (framesOf(text).length > replayed.length ? true : undefined))
      const live = framesOf(text)

      abort.abort()
      await pump
      const closed = await until("the tail to close", async () => (openStreams() === 0 ? true : undefined), 5_000)
      return { before, replayed, live, closed }
    })

    // Replay starts past the id the client held and repeats nothing.
    expect(read.replayed[0]!.id).toBe("3")
    expect(read.replayed.map((frame) => frame.id)).toEqual(read.before.slice(2).map((row) => String(row.seq)))
    expect(JSON.parse(read.replayed[0]!.data)).toEqual(read.before[2]!.event as never)
    // The live frames continue the same numbering, and every id appears exactly once.
    const ids = read.live.map((frame) => frame.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.map(Number)).toEqual(ids.map((_, i) => i + 3))
    expect(read.live.some((frame) => JSON.parse(frame.data).id === "m2")).toBe(true)
    // And the disconnect took the poll with it.
    expect(read.closed).toBe(true)
  })

  test("the actor threads stream starts with a snapshot and resumes with additions", async () => {
    const read = await serving(async (base) => {
      const firstAbort = new AbortController()
      const firstResponse = await fetch(`${base}/v1/actors/main/threads/stream`, { signal: firstAbort.signal })
      expect(firstResponse.status).toBe(200)
      expect(firstResponse.headers.get("content-type")).toContain("text/event-stream")
      const firstReader = firstResponse.body!.getReader()
      const decoder = new TextDecoder()
      let firstText = ""
      const firstPump = (async () => {
        for (;;) {
          const chunk = await firstReader.read()
          if (chunk.done) return
          firstText += decoder.decode(chunk.value, { stream: true })
        }
      })().catch(() => undefined)

      await until("the empty actor snapshot", async () => framesOf(firstText).length === 1 ? true : undefined)
      const empty = framesOf(firstText)[0]!
      await birth(base, "alpha", { id: "m1", text: "hello" })
      await until("the first thread addition", async () => {
        const latest = framesOf(firstText).at(-1)
        if (latest === undefined) return undefined
        const event = JSON.parse(latest.data) as { thread?: { readonly id?: string } }
        return event.thread?.id === "alpha" ? true : undefined
      })
      await sleep(50)
      const populated = framesOf(firstText).at(-1)!
      firstAbort.abort()
      await firstReader.cancel().catch(() => undefined)
      await firstPump

      const resumedAbort = new AbortController()
      const resumedResponse = await fetch(`${base}/v1/actors/main/threads/stream?after=0`, {
        headers: { "last-event-id": populated.id },
        signal: resumedAbort.signal
      })
      expect(resumedResponse.status).toBe(200)
      const resumedReader = resumedResponse.body!.getReader()
      let resumedText = ""
      const resumedPump = (async () => {
        for (;;) {
          const chunk = await resumedReader.read()
          if (chunk.done) return
          resumedText += decoder.decode(chunk.value, { stream: true })
        }
      })().catch(() => undefined)

      await sleep(40)
      const before = framesOf(resumedText)
      await birth(base, "beta", { id: "m2", text: "again" })
      await until("the resumed thread addition", async () => framesOf(resumedText).length >= 1 ? true : undefined)
      const resumed = framesOf(resumedText).at(-1)!
      resumedAbort.abort()
      await resumedReader.cancel().catch(() => undefined)
      await resumedPump
      return { empty, populated, before, resumed }
    })

    expect(JSON.parse(read.empty.data)).toEqual({ type: "ThreadsSnapshot", threads: [] })
    expect(JSON.parse(read.populated.data)).toMatchObject({
      type: "ThreadAdded",
      thread: { id: "alpha" }
    })
    expect(read.before).toEqual([])
    expect(Number(read.resumed.id)).toBeGreaterThan(Number(read.populated.id))
    expect(JSON.parse(read.resumed.data)).toMatchObject({
      type: "ThreadAdded",
      thread: { id: "beta" }
    })
  })
})

// The projections the actor declares are mounted by name under a thread's projection namespace, and this build's actor
// declares `turns` (actor.ts, agentProjections). The cases below are about the mounting: that a
// declared name serves what the actor computes, that its own query reaches `run`, and that any
// other name says what does exist.
describe("projections", () => {
  test("a declared projection serves what the actor computes", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const response = await fetch(`${base}/v1/actors/main/threads/alpha/projections/turns`)
      return { status: response.status, body: await response.json() as ReadonlyArray<TurnView> }
    })
    expect(read.status).toBe(200)
    expect(read.body).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
  })

  test("a name the actor never declared says what does exist", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const read = async (path: string) => {
        const response = await fetch(`${base}${path}`)
        return {
          status: response.status,
          type: response.headers.get("content-type"),
          body: await response.json() as Record<string, unknown>
        }
      }
      return {
        ghost: await read("/v1/actors/main/threads/alpha/projections/facts")
      }
    })
    expect(answers.ghost.status).toBe(404)
    expect(answers.ghost.type).toContain(PROBLEM_CONTENT_TYPE)
    expect(answers.ghost.body).toMatchObject({
      type: `${PROBLEM_TYPE_BASE}unknown-projection`,
      title: "Unknown Projection"
    })
    // The detail lists what the actor does declare, so a caller who guessed a name learns the ones
    // that exist rather than only that this one does not.
    expect(String(answers.ghost.body["detail"])).toContain('"turns"')
  })

  test("the event log keeps its platform route", async () => {
    const answers = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const events = await fetch(`${base}/v1/actors/main/threads/alpha/events`)
      return { status: events.status, type: events.headers.get("content-type") }
    })
    expect(answers.status).toBe(200)
    expect(answers.type).toContain("application/json")
  })

  test("`at` reads the log's prefix, which takes a completed turn back to pending", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<TurnView>
      return {
        now: await json("/v1/actors/main/threads/alpha/projections/turns"),
        atTwo: await json("/v1/actors/main/threads/alpha/projections/turns?at=2")
      }
    })
    expect(read.now).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
    // Creation and the message stand before the cut, with nothing that answered the turn.
    expect(read.atTwo).toEqual([{ turn: "m1", status: "pending", epoch: 0 }])
  })

  // The single lookup is the same projection with its `turn` query, which is why the platform keeps
  // no turn-shaped route at all (actor.ts, agentProjections).
  test("`turn` narrows the projection to one entry, and an unknown turn is an empty array", async () => {
    const read = await serving(async (base) => {
      await birth(base, "alpha", { id: "m1", text: "hello" })
      const json = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as ReadonlyArray<TurnView>
      return {
        one: await json("/v1/actors/main/threads/alpha/projections/turns?turn=m1"),
        ghost: await json("/v1/actors/main/threads/alpha/projections/turns?turn=m9")
      }
    })
    expect(read.one).toEqual([{ turn: "m1", status: "completed", epoch: 0, output: "ok: hello" }])
    // A turn nobody was asked to serve matches nothing. It is not a failure: asking a projection
    // about an id it has never seen is a question with an empty answer.
    expect(read.ghost).toEqual([])
  })
})

describe("the tree", () => {
  test("a spawned child hangs under the thread whose code briefed it", async () => {
    const read = await serving(async (base) => {
      await birth(base, "root", { id: "m1", text: "spawn call-1" })
      // The root's turn can complete while the child's thread is still settling, so the tree read
      // waits for the driver to rest; resting means every thread's owed work is done.
      await until("the driver rests", async () => {
        const health = (await (await fetch(`${base}/healthz`)).json()) as { status: string }
        return health.status === "resting" ? health : undefined
      })
      return {
        tree: (await (await fetch(`${base}/v1/actors/main/threads/root/tree`)).json()) as ThreadNode,
        listed: (await (await fetch(`${base}/v1/actors/main/threads`)).json()) as ReadonlyArray<ThreadSummary>,
        ghost: (await fetch(`${base}/v1/actors/main/threads/ghost/tree`)).status
      }
    })
    expect(read.tree.id).toBe("root")
    expect(read.tree.depth).toBe(0)
    expect(read.tree.children).toHaveLength(1)
    const child = read.tree.children[0]!
    expect(child.parent).toBe("root")
    expect(child.depth).toBe(1)
    expect(child.children).toEqual([])
    // The child is a thread like any other: it lists, with the same parent the tree gave it.
    expect(read.listed.map((summary) => summary.id).sort()).toEqual(["root", child.id].sort())
    expect(read.listed.find((summary) => summary.id === child.id)!.parent).toBe("root")
    expect(read.ghost).toBe(404)
  })
})
