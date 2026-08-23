import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { actor, agentsPackage, budget, codeMode, compaction, fetchPackage, Infer, infer as inferAgent, outputValidateOnce, reply, workspacePackage } from "tardie"
import type { Action } from "tardie/events"
import { infer } from "@clavia/tardigrade-model/model"
import type { Event } from "@clavia/tardigrade-core/event"
import { traceparentOf } from "@clavia/tardigrade-core/trace"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { directoryRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { ActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { DEFAULT_MAX_CONCURRENT_LANES, driverPolicyOf } from "@clavia/tardigrade-host/driver"
import { alarmPolicyOf, armAt, nextAlarm, type AlarmPolicy } from "./alarm"
import { createCloudflareHost, type CloudflareHost } from "./host"

export interface Env {
  readonly ACTORS: DurableObjectNamespace<ActorHost>
  readonly MODEL_BASE_URL?: string
  readonly MODEL_API_KEY?: string
  readonly MODEL_ID?: string
  readonly MODEL_PROVIDER?: string
  readonly TARDIGRADE_TOKEN?: string
  readonly TARDIGRADE_MAX_CONCURRENT_LANES?: string
  readonly TARDIGRADE_ALARM_DELAY_MILLIS?: string
}

const LANE_PREFIX = "ag."
const laneOf = (thread: string): string => `${LANE_PREFIX}${thread}`
const threadOf = (lane: string): string | undefined => lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

const assembly = actor(inferAgent([
  codeMode([agentsPackage(), workspacePackage(), fetchPackage()]),
  reply,
  budget,
  compaction,
  outputValidateOnce
]))

const modelLayer = (env: Env) => {
  if (env.MODEL_BASE_URL === undefined || env.MODEL_API_KEY === undefined || env.MODEL_ID === undefined) {
    const failed: Action = { kind: "fail", error: "no model is configured", failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({ react: () => Effect.succeed(failed) })
  }
  return infer({
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    model: env.MODEL_ID,
    ...(env.MODEL_PROVIDER === undefined ? {} : { provider: env.MODEL_PROVIDER })
  })
}

const positiveInteger = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return value
}

const nonNegativeInteger = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  return value
}

// ActorHost runs one actor graph over one SQLite-backed Durable Object.
export class ActorHost extends DurableObject<Env> {
  private runtime: Promise<CloudflareHost> | undefined
  private principal: string | undefined
  private readonly alarmPolicy: AlarmPolicy

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS actor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this.alarmPolicy = alarmPolicyOf({
      delayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS")
    })
  }

  async init(principal: string): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_meta (key, value) VALUES ('principal', ?)", principal)
    const stored = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").one().value
    if (stored !== principal) throw new Error("actor host principal does not match its durable identity")
    this.principal ??= stored
  }

  private name(): string {
    if (this.principal !== undefined) return this.principal
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").toArray()[0]
    if (row === undefined) throw new Error("actor host has not been initialized")
    return this.principal = row.value
  }

  private host(): Promise<CloudflareHost> {
    if (this.runtime !== undefined) return this.runtime
    const principal = this.name()
    const remoteTransport: Transport<ActorId, ActorEnvelope> = {
      name: "durable-object",
      send: (destination, envelope) => Effect.currentSpan.pipe(
        Effect.option,
        Effect.flatMap((current) => {
          const event = current._tag === "Some" && (envelope.event as { readonly traceparent?: unknown }).traceparent === undefined
            ? ({ ...envelope.event, traceparent: traceparentOf(current.value) } as Event)
            : envelope.event
          return Effect.promise(async () => {
            const stub = this.env.ACTORS.getByName(destination.actor)
            await stub.init(destination.actor)
            await stub.deliver({ ...envelope, event })
          })
        })
      )
    }
    const remoteRoute = directoryRoute(
      remoteTransport,
      mappedDirectory((id: ActorId) => id.actor === principal ? undefined : id),
      isActorEnvelope,
      (envelope) => envelope.link.target
    )
    this.runtime = createCloudflareHost({
      storage: this.ctx.storage,
      principal,
      actorFor: (lane) => threadOf(lane) === undefined ? undefined : assembly,
      layersFor: () => Layer.mergeAll(modelLayer(this.env), FetchHttpClient.layer),
      routes: [remoteRoute],
      driver: driverPolicyOf({
        maxConcurrentLanes: positiveInteger(
          this.env.TARDIGRADE_MAX_CONCURRENT_LANES,
          DEFAULT_MAX_CONCURRENT_LANES,
          "TARDIGRADE_MAX_CONCURRENT_LANES"
        )
      }),
      keyOf: assembly.keyOf
    })
    return this.runtime
  }

  private async arm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.delayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
  }

  async append(thread: string, event: Event): Promise<void> {
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    const host = await this.host()
    await host.commitRoot(host.self(laneOf(thread)), stamped)
    await this.arm()
  }

  async deliver(envelope: ActorEnvelope): Promise<void> {
    if (envelope.link.target.actor !== this.name()) throw new Error("delivery target does not match actor host")
    await (await this.host()).commit(envelope)
    await this.arm()
  }

  async events(thread: string): Promise<ReadonlyArray<Event>> {
    return (await this.host()).read(laneOf(thread))
  }

  async threads(): Promise<ReadonlyArray<{ readonly id: string; readonly events: number }>> {
    const host = await this.host()
    const summaries: Array<{ readonly id: string; readonly events: number }> = []
    for (const lane of await host.lanes()) {
      const id = threadOf(lane)
      if (id !== undefined) summaries.push({ id, events: (await host.read(lane)).length })
    }
    return summaries
  }

  async status(): Promise<{ readonly status: "resting" | "driving"; readonly dirty: number }> {
    const host = await this.host()
    return { status: await host.resting() ? "resting" : "driving", dirty: host.work() }
  }

  async alarm(): Promise<void> {
    const host = await this.host()
    await host.recover()
    const armedDuringPass = await this.ctx.storage.getAlarm()
    const next = nextAlarm(armedDuringPass, !host.resting(), Date.now(), this.alarmPolicy)
    if (next === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(next)
  }
}

const actorStub = async (env: Env, name: string): Promise<DurableObjectStub<ActorHost>> => {
  const stub = env.ACTORS.getByName(name)
  await stub.init(name)
  return stub
}

class WorkerEnv extends Context.Service<WorkerEnv, Env>()("tardigrade/cloudflare/WorkerEnv") {}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

const authorized = (request: HttpServerRequest.HttpServerRequest, env: Env): boolean =>
  env.TARDIGRADE_TOKEN !== undefined && request.headers.authorization === `Bearer ${env.TARDIGRADE_TOKEN}`

const guard = (request: HttpServerRequest.HttpServerRequest, env: Env) => {
  if (env.TARDIGRADE_TOKEN === undefined) return json({ error: "authentication is not configured" }, 503)
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401)
  return undefined
}

const protectedRoute = <E, R>(
  f: (
    request: HttpServerRequest.HttpServerRequest,
    env: Env
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const env = yield* WorkerEnv
  const refused = guard(request, env)
  return refused ?? (yield* f(request, env))
})

const routes = [
  HttpRouter.route("GET", "/healthz", Effect.gen(function* () {
    const env = yield* WorkerEnv
    return json(yield* Effect.promise(async () => (await actorStub(env, "default")).status()))
  })),
  HttpRouter.route("GET", "/v1/actors", protectedRoute((_request, _env) =>
    Effect.succeed(json([{ name: "default", builtIn: true }]))
  )),
  HttpRouter.route("GET", "/v1/actors/:actor/threads", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      if (actor !== "default") return json({ error: "unknown actor" }, 404)
      return json(yield* Effect.promise(async () => (await actorStub(env, actor)).threads()))
    })
  )),
  HttpRouter.route("POST", "/v1/actors/:actor/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      const thread = decodeURIComponent(params.thread ?? "")
      if (actor !== "default") return json({ error: "unknown actor" }, 404)
      const event = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as Event | undefined
      if (typeof event !== "object" || event === null || typeof event.type !== "string" || event.type === "") {
        return json({ error: "event type is required" }, 400)
      }
      yield* Effect.promise(async () => (await actorStub(env, actor)).append(thread, event))
      return json({ actor, thread }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:actor/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      const thread = decodeURIComponent(params.thread ?? "")
      if (actor !== "default") return json({ error: "unknown actor" }, 404)
      const url = new URL(request.url, "http://worker")
      const after = Number(url.searchParams.get("after") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 200)
      const types = url.searchParams.get("types")?.split(",")
      return yield* Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<Event>> => (await actorStub(env, actor)).events(thread),
        catch: (cause) => cause instanceof Error ? cause.message : String(cause)
      }).pipe(Effect.match({
        onFailure: (error) => json({ error }, 500),
        onSuccess: (events) => json(events.map((event, index) => ({ seq: index + 1, event }))
          .filter((row) => row.seq > after && (types === undefined || types.includes(row.event.type)))
          .slice(0, limit))
      }))
    })
  )),
  HttpRouter.route("*", "/*", json({ error: "not found" }, 404))
] as const

const router = Effect.runSync(HttpRouter.make)
// routes carry request requirements as registration markers; addAll records them without running a handler (effect/unstable/http/HttpRouter.ts, addAll).
// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
Effect.runSync(router.addAll(routes) as Effect.Effect<void>)
// httpApp handles the router's opaque internal failure at the web boundary.
// @effect-diagnostics-next-line anyUnknownInErrorContext:off
const httpApp = router.asHttpEffect().pipe(Effect.orElseSucceed(() => json({ error: "internal server error" }, 500)))
const webHandler = HttpEffect.toWebHandler(httpApp)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return webHandler(request, Context.make(WorkerEnv, env) as Context.Context<never>)
  }
} satisfies ExportedHandler<Env>
