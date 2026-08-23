import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { actor, agentsPackage, budget, codeMode, compaction, fetchPackage, Infer, infer as inferAgent, outputValidateOnce, reply, workspacePackage } from "tardie"
import type { Action } from "tardie/events"
import { infer, modelContextWindowTokensOf, modelIdOf } from "@clavia/tardigrade-model/model"
import { modelDriverOf } from "@clavia/tardigrade-model/connection"
import type { Event } from "@clavia/tardigrade-core/event"
import { traceparentOf } from "@clavia/tardigrade-core/trace"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { directoryRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { ActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { DEFAULT_MAX_CONCURRENT_LANES, driverPolicyOf } from "@clavia/tardigrade-host/driver"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox"
import { alarmPolicyOf, armAt, nextAlarm, type AlarmPolicy } from "./alarm"
import { createCloudflareHost, type CloudflareHost } from "./host"
import {
  layerCloudflareSandbox,
  type SandboxBridgeCall,
  type CloudflareSandboxLimits,
  type SandboxBridgeLease
} from "./sandbox"
import {
  CloudflareActorRegistry,
  layerCloudflareActorRegistry,
  type CloudflareActorRegistration
} from "./registry"

export interface Env {
  readonly ACTORS: DurableObjectNamespace<ActorHost>
  readonly REGISTRY: D1Database
  readonly LOADER: WorkerLoader
  readonly MODEL_BASE_URL?: string
  readonly MODEL_API_KEY?: string
  readonly MODEL_ID?: string
  readonly MODEL_DRIVER?: string
  readonly MODEL_CONNECTION?: string
  readonly MODEL_SONNET_ID?: string
  readonly MODEL_OPUS_ID?: string
  readonly MODEL_HAIKU_ID?: string
  readonly MODEL_PROVIDER?: string
  readonly MODEL_CONTEXT_WINDOW_TOKENS?: string
  readonly MODEL_SONNET_CONTEXT_WINDOW_TOKENS?: string
  readonly MODEL_OPUS_CONTEXT_WINDOW_TOKENS?: string
  readonly MODEL_HAIKU_CONTEXT_WINDOW_TOKENS?: string
  readonly TARDIGRADE_TOKEN?: string
  readonly TARDIGRADE_MAX_CONCURRENT_LANES?: string
  readonly TARDIGRADE_ALARM_DELAY_MILLIS?: string
  readonly TARDIGRADE_COMPACTION_FIRE_RATIO?: string
  readonly TARDIGRADE_COMPACTION_KEEP_RATIO?: string
  readonly TARDIGRADE_SANDBOX_LOG_CAP_BYTES?: string
  readonly TARDIGRADE_SANDBOX_CPU_MILLIS?: string
  readonly TARDIGRADE_SANDBOX_SUBREQUESTS?: string
}

const LANE_PREFIX = "ag."
const laneOf = (thread: string): string => `${LANE_PREFIX}${thread}`
const threadOf = (lane: string): string | undefined => lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

// DEFAULT_ACTOR_REGISTRATION exposes the actor this Worker deploys when no external artifact has been registered.
export const DEFAULT_ACTOR_REGISTRATION: CloudflareActorRegistration = {
  name: "default",
  assembly: "default",
  host: "default",
  builtIn: true
}

const assemblies = new Set([DEFAULT_ACTOR_REGISTRATION.assembly])
export const DEFAULT_MODEL_CONNECTION = "default"
const registryRuntimes = new WeakMap<D1Database, ManagedRuntime.ManagedRuntime<CloudflareActorRegistry, never>>()

const actorRegistry = async (env: Env) => {
  let runtime = registryRuntimes.get(env.REGISTRY)
  if (runtime === undefined) {
    runtime = ManagedRuntime.make(layerCloudflareActorRegistry(env.REGISTRY))
    registryRuntimes.set(env.REGISTRY, runtime)
  }
  const registry = await runtime.runPromise(CloudflareActorRegistry)
  if ((await Effect.runPromise(registry.resolve(DEFAULT_ACTOR_REGISTRATION.name))) === undefined) {
    await Effect.runPromise(registry.put(DEFAULT_ACTOR_REGISTRATION))
  }
  return registry
}

const modelLayer = (env: Env) => {
  if (env.MODEL_BASE_URL === undefined || env.MODEL_API_KEY === undefined || env.MODEL_ID === undefined || env.MODEL_DRIVER === undefined) {
    const failed: Action = { kind: "fail", error: "no model is configured", failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({ react: () => Effect.succeed(failed) })
  }
  const baseUrl = env.MODEL_BASE_URL
  const apiKey = env.MODEL_API_KEY
  const driver = modelDriverOf(env.MODEL_DRIVER)
  return Layer.succeed(Infer, {
    react: (request, key) => {
      const asked = request.model
      if (typeof asked === "object" && asked.connection !== undefined && asked.connection !== (env.MODEL_CONNECTION ?? DEFAULT_MODEL_CONNECTION)) {
        return Effect.succeed({
          kind: "fail" as const,
          error: `unknown model connection ${JSON.stringify(asked.connection)}`,
          failure: { cause: "inference_error" as const, attempts: 0 }
        })
      }
      const selected = infer({
        baseUrl,
        apiKey,
        model: modelIdOf(env, typeof asked === "string" ? asked : asked?.id),
        driver,
        ...(env.MODEL_PROVIDER === undefined ? {} : { provider: env.MODEL_PROVIDER })
      })
      return Effect.flatMap(Infer, (model) => model.react(request, key)).pipe(Effect.provide(selected))
    }
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

const optionalNonNegativeInteger = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined) return undefined
  return nonNegativeInteger(raw, 0, name)
}

const optionalRatio = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1, got ${JSON.stringify(raw)}`)
  }
  return value
}

const assemblyOf = (name: string, env: Env) => {
  if (!assemblies.has(name)) return undefined
  const fireRatio = optionalRatio(env.TARDIGRADE_COMPACTION_FIRE_RATIO, "TARDIGRADE_COMPACTION_FIRE_RATIO")
  const keepRatio = optionalRatio(env.TARDIGRADE_COMPACTION_KEEP_RATIO, "TARDIGRADE_COMPACTION_KEEP_RATIO")
  return actor(inferAgent([
    codeMode([agentsPackage(), workspacePackage(), fetchPackage()]),
    reply,
    budget,
    compaction({
      contextWindowTokens: (model) => modelContextWindowTokensOf(env, typeof model === "string" ? model : model?.id),
      ...(fireRatio === undefined ? {} : { fireRatio }),
      ...(keepRatio === undefined ? {} : { keepRatio })
    }),
    outputValidateOnce
  ]))
}

// ActorHost runs one actor graph over one SQLite-backed Durable Object.
export class ActorHost extends DurableObject<Env> {
  private runtime: Promise<CloudflareHost> | undefined
  private principal: string | undefined
  private readonly alarmPolicy: AlarmPolicy
  private readonly sandboxCalls = new Map<
    string,
    (ordinal: number, packageName: string, method: string, args: unknown) => Promise<SandboxCallOutcome>
  >()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS actor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this.alarmPolicy = alarmPolicyOf({
      delayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS")
    })
  }

  async init(registration: CloudflareActorRegistration): Promise<void> {
    if (!assemblies.has(registration.assembly)) throw new Error(`actor assembly ${JSON.stringify(registration.assembly)} is not deployed`)
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_meta (key, value) VALUES ('principal', ?)", registration.name)
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_meta (key, value) VALUES ('assembly', ?)", registration.assembly)
    const principal = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").one().value
    const assemblyKey = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'assembly'").one().value
    if (principal !== registration.name || assemblyKey !== registration.assembly) {
      throw new Error("actor host registration does not match its durable identity")
    }
    this.principal ??= principal
  }

  private name(): string {
    if (this.principal !== undefined) return this.principal
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").toArray()[0]
    if (row === undefined) throw new Error("actor host has not been initialized")
    return this.principal = row.value
  }

  async sandboxCallBatch(
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    const call = this.sandboxCalls.get(execution)
    if (call === undefined) throw new Error(`sandbox execution ${JSON.stringify(execution)} is unavailable`)
    return Promise.all(calls.map((entry) => call(entry.ordinal, entry.packageName, entry.method, entry.args)))
  }

  private host(): Promise<CloudflareHost> {
    if (this.runtime !== undefined) return this.runtime
    const principal = this.name()
    const assemblyKey = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'assembly'").one().value
    const selectedAssembly = assemblyOf(assemblyKey, this.env)
    if (selectedAssembly === undefined) throw new Error(`actor assembly ${JSON.stringify(assemblyKey)} is not deployed`)
    const sandboxCpuMs = optionalNonNegativeInteger(this.env.TARDIGRADE_SANDBOX_CPU_MILLIS, "TARDIGRADE_SANDBOX_CPU_MILLIS")
    const sandboxSubRequests = optionalNonNegativeInteger(
      this.env.TARDIGRADE_SANDBOX_SUBREQUESTS,
      "TARDIGRADE_SANDBOX_SUBREQUESTS"
    )
    const sandboxLimits: CloudflareSandboxLimits = {
      ...(sandboxCpuMs === undefined ? {} : { cpuMs: sandboxCpuMs }),
      ...(sandboxSubRequests === undefined ? {} : { subRequests: sandboxSubRequests })
    }
    const actorName = this.ctx.id.name
    if (actorName === undefined) throw new Error("actor host requires a named durable object")
    const sandboxLayer = layerCloudflareSandbox(
      this.env.LOADER,
      (call): SandboxBridgeLease => {
        const execution = crypto.randomUUID()
        this.sandboxCalls.set(execution, call)
        return {
          binding: this.env.ACTORS.getByName(actorName),
          execution,
          close: () => {
            this.sandboxCalls.delete(execution)
          }
        }
      },
      {
        ...(this.env.TARDIGRADE_SANDBOX_LOG_CAP_BYTES === undefined
          ? {}
          : { logCapBytes: nonNegativeInteger(this.env.TARDIGRADE_SANDBOX_LOG_CAP_BYTES, 0, "TARDIGRADE_SANDBOX_LOG_CAP_BYTES") }),
        ...(Object.keys(sandboxLimits).length === 0 ? {} : { limits: sandboxLimits })
      }
    )
    const remoteTransport: Transport<ActorId, ActorEnvelope> = {
      name: "durable-object",
      send: (destination, envelope) => Effect.currentSpan.pipe(
        Effect.option,
        Effect.flatMap((current) => {
          const event = current._tag === "Some" && (envelope.event as { readonly traceparent?: unknown }).traceparent === undefined
            ? ({ ...envelope.event, traceparent: traceparentOf(current.value) } as Event)
            : envelope.event
          return Effect.promise(async () => {
            const registration = await Effect.runPromise((await actorRegistry(this.env)).resolve(destination.actor))
            if (registration === undefined) throw new Error(`actor ${JSON.stringify(destination.actor)} is not registered`)
            const stub = this.env.ACTORS.getByName(registration.host)
            await stub.init(registration)
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
      actorFor: (lane) => threadOf(lane) === undefined ? undefined : selectedAssembly,
      layersFor: () => Layer.mergeAll(modelLayer(this.env), FetchHttpClient.layer, sandboxLayer),
      routes: [remoteRoute],
      driver: driverPolicyOf({
        maxConcurrentLanes: positiveInteger(
          this.env.TARDIGRADE_MAX_CONCURRENT_LANES,
          DEFAULT_MAX_CONCURRENT_LANES,
          "TARDIGRADE_MAX_CONCURRENT_LANES"
        )
      }),
      keyOf: selectedAssembly.keyOf
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

const actorStub = async (
  env: Env,
  registry: Context.Service.Shape<typeof CloudflareActorRegistry>,
  name: string
): Promise<DurableObjectStub<ActorHost> | undefined> => {
  const registration = await Effect.runPromise(registry.resolve(name))
  if (registration === undefined) return undefined
  const stub = env.ACTORS.getByName(registration.host)
  await stub.init(registration)
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
    const registry = yield* CloudflareActorRegistry
    return json(yield* Effect.promise(async () => (await actorStub(env, registry, DEFAULT_ACTOR_REGISTRATION.name))!.status()))
  })),
  HttpRouter.route("GET", "/v1/actors", protectedRoute((_request, _env) => Effect.gen(function* () {
    const registry = yield* CloudflareActorRegistry
    const registrations = yield* registry.list
    return json(registrations.map(({ name, builtIn, digest }) => ({ name, builtIn, ...(digest === undefined ? {} : { digest }) })))
  }))),
  HttpRouter.route("GET", "/v1/actors/:actor/threads", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      const registry = yield* CloudflareActorRegistry
      const stub = yield* Effect.promise(() => actorStub(env, registry, actor))
      if (stub === undefined) return json({ error: "unknown actor" }, 404)
      return json(yield* Effect.promise(() => stub.threads()))
    })
  )),
  HttpRouter.route("POST", "/v1/actors/:actor/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      const thread = decodeURIComponent(params.thread ?? "")
      const registry = yield* CloudflareActorRegistry
      const stub = yield* Effect.promise(() => actorStub(env, registry, actor))
      if (stub === undefined) return json({ error: "unknown actor" }, 404)
      const event = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as Event | undefined
      if (typeof event !== "object" || event === null || typeof event.type !== "string" || event.type === "") {
        return json({ error: "event type is required" }, 400)
      }
      yield* Effect.promise(() => stub.append(thread, event))
      return json({ actor, thread }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:actor/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = decodeURIComponent(params.actor ?? "")
      const thread = decodeURIComponent(params.thread ?? "")
      const registry = yield* CloudflareActorRegistry
      const stub = yield* Effect.promise(() => actorStub(env, registry, actor))
      if (stub === undefined) return json({ error: "unknown actor" }, 404)
      const url = new URL(request.url, "http://worker")
      const after = Number(url.searchParams.get("after") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 200)
      const types = url.searchParams.get("types")?.split(",")
      return yield* Effect.tryPromise({
        try: (): Promise<ReadonlyArray<Event>> => stub.events(thread),
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
    const registry = await actorRegistry(env)
    return webHandler(request, Context.make(WorkerEnv, env).pipe(
      Context.add(CloudflareActorRegistry, registry)
    ) as Context.Context<never>)
  }
} satisfies ExportedHandler<Env>
