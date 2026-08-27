import { DurableObject } from "cloudflare:workers"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { actor, agentMethods, agentsPackage, applyModelPolicy, budget, codeMode, compaction, fetchPackage, Infer, infer as inferAgent, intersectModelPolicies, modelAllowedBy, outputValidateOnce, workspacePackage, type Actor, type ActorMethods, type ModelPolicy, type ModelRef } from "tardie"
import type { Action } from "tardie/log/events"
import {
  CATALOG_AVAILABILITY_FILTERS,
  MODEL_CATALOG_PRICE_SORTS,
  MODEL_CATALOG_SORT_ORDERS,
  MODEL_CATALOG_UNPRICED_ORDERS
} from "@clavia/tardigrade-client/contract"
import { infer } from "@clavia/tardigrade-model/model"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"
import {
  loadModelCatalog,
  type ModelCatalogLoadPolicy,
  type ModelCatalogState
} from "@clavia/tardigrade-server/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-server/catalog-availability"
import { modelsPageOf, providersPageOf } from "@clavia/tardigrade-server/catalog-page"
import { modelConfigOf, type ModelProviderConfig } from "@clavia/tardigrade-server/config"
import { treeOf, type ThreadNode, type ThreadSummary } from "@clavia/tardigrade-server/projections"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { directoryRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { ActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { DEFAULT_MAX_CONCURRENT_LANES, driverPolicyOf } from "@clavia/tardigrade-host/driver"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"
import {
  layerWorkerLoaderSandbox,
  type SandboxBridgeCall,
  type SandboxBridgeLease,
  type WorkerLoaderSandboxLimits,
  type WorkerLoaderSandboxTransport
} from "@clavia/tardigrade-worker-loader/sandbox"
import { alarmPolicyOf, armAt, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import { createCloudflareHost, type CloudflareHost } from "./host"
import { layerCloudflareModelCatalogRepository } from "./catalog"
import { structuredWorkerConfigOf } from "./config"

export interface Env {
  readonly ACTORS: DurableObjectNamespace<ActorHost>
  readonly LOADER: WorkerLoader
  readonly TARDIGRADE_CONFIG?: unknown
  readonly TARDIGRADE_TOKEN?: string
  readonly TARDIGRADE_MODEL_CATALOG_URL?: string
  readonly TARDIGRADE_MODEL_CATALOG_LOAD_POLICY?: string
  readonly TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS?: string
  readonly TARDIGRADE_MAX_CONCURRENT_LANES?: string
  readonly TARDIGRADE_ALARM_DELAY_MILLIS?: string
  readonly TARDIGRADE_COMPACTION_FIRE_RATIO?: string
  readonly TARDIGRADE_COMPACTION_KEEP_RATIO?: string
  readonly TARDIGRADE_SANDBOX_LOG_CAP_BYTES?: string
  readonly TARDIGRADE_SANDBOX_CPU_MILLIS?: string
  readonly TARDIGRADE_SANDBOX_SUBREQUESTS?: string
  readonly TARDIGRADE_SANDBOX_TRANSPORT?: string
}

const LANE_PREFIX = "ag."
const laneOf = (thread: string): string => `${LANE_PREFIX}${thread}`
const threadOf = (lane: string): string | undefined => lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

const flattenThreads = (nodes: ReadonlyArray<ThreadNode>): ReadonlyArray<ThreadSummary> =>
  nodes.flatMap(({ children, ...summary }) => [summary, ...flattenThreads(children)])

const DEFAULT_ACTOR_NAME = "default"

type DefaultAssembly = ReturnType<typeof defaultAssemblyOf>

interface MountedActor {
  readonly name: string
  readonly actor: DefaultAssembly
  readonly methods: ActorMethods
}

let mountedActor: MountedActor | undefined
let deployedActor = DEFAULT_ACTOR_NAME

// DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS bounds the catalog refresh made once per Worker isolate.
export const DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS = 10_000

// DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY refreshes the actor snapshot once per Durable Object isolate.
export const DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY: ModelCatalogLoadPolicy = "refresh"

const deployed = (name: string): boolean => deployedActor === name

interface CloudflareProvider extends ModelProviderConfig {
  readonly apiKey: string
}

interface CloudflareModels extends ModelPolicy {
  readonly default: ModelRef
  readonly providers: Readonly<Record<string, CloudflareProvider>>
}

const credentialFrom = (workerEnv: Env, provider: string, names: ReadonlyArray<string>): string => {
  if (names.length === 0) throw new Error(`TARDIGRADE_CONFIG.models provider ${JSON.stringify(provider)} must declare env`)
  const values = workerEnv as unknown as Readonly<Record<string, unknown>>
  for (const name of names) {
    const value = values[name]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  throw new Error(`provider ${JSON.stringify(provider)} needs a credential; set ${names.join(" or ")} as a Worker secret or variable`)
}

const modelsFrom = (env: Env): CloudflareModels | undefined => {
  const config = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)
  const rawModels = config?.["models"]
  if (rawModels === undefined) return undefined
  const parsed = modelConfigOf(rawModels)
  if (parsed.default === undefined) {
    throw new Error("TARDIGRADE_CONFIG.models must declare default { provider, model_id }")
  }
  const providers: Record<string, CloudflareProvider> = {}
  for (const [name, provider] of Object.entries(parsed.providers)) {
    providers[name] = {
      ...provider,
      apiKey: credentialFrom(env, name, provider.env)
    }
  }
  return { default: parsed.default, allow: parsed.allow, providers }
}

const providerAvailabilityFrom = (env: Env) => {
  const config = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)
  const parsed = modelConfigOf(config?.["models"] ?? { allow: "*" })
  const values = env as unknown as Readonly<Record<string, unknown>>
  const credentials = Object.fromEntries(
    Object.values(parsed.providers).flatMap((provider) => provider.env.flatMap((name) => {
      const value = values[name]
      return typeof value === "string" && value.trim().length > 0 ? [[name, value]] : []
    }))
  )
  return providerAvailabilitiesOf(parsed, credentials)
}

const modelPolicyFrom = (env: Env): ModelPolicy => {
  const config = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)
  const parsed = modelConfigOf(config?.["models"] ?? { allow: "*" })
  return { ...(parsed.default === undefined ? {} : { default: parsed.default }), allow: parsed.allow }
}

const providerAvailabilityFromModels = (models: CloudflareModels | undefined) => models === undefined
  ? {}
  : providerAvailabilitiesOf(models, Object.fromEntries(
      Object.values(models.providers).flatMap((provider) => provider.env.map((name) => [name, provider.apiKey]))
    ))

const selectedModelFrom = (
  models: CloudflareModels,
  catalog: ModelCatalogState,
  reference?: ModelRef
) => {
  const selected = reference ?? models.default
  if (!modelAllowedBy(models, selected)) throw new Error(`model ${selected.provider}/${selected.model_id} is excluded by the host model policy`)
  const provider = models.providers[selected.provider]
  if (provider === undefined) throw new Error(`provider ${JSON.stringify(selected.provider)} is not configured; update TARDIGRADE_CONFIG.models`)
  if (catalog.snapshot === undefined) {
    throw new Error(`model catalog metadata is unavailable for ${selected.provider}/${selected.model_id}; check the Worker logs`)
  }
  const catalogProvider = catalog.snapshot.providers.find((candidate) => candidate.id === selected.provider)
  if (catalogProvider === undefined) {
    throw new Error(`provider ${JSON.stringify(selected.provider)} is absent from model catalog revision ${JSON.stringify(catalog.snapshot.revision)}`)
  }
  const model = catalogProvider.models.find((candidate) => candidate.id === selected.model_id)
  if (model === undefined) {
    throw new Error(`model ${selected.provider}/${selected.model_id} is absent from model catalog revision ${JSON.stringify(catalog.snapshot.revision)}`)
  }
  const contextWindowTokens = model.metadata.contextWindowTokens
  if (contextWindowTokens === undefined) {
    throw new Error(`model catalog has no context window for ${selected.provider}/${selected.model_id}`)
  }
  return { reference: selected, provider, metadata: model.metadata, contextWindowTokens, catalogRevision: catalog.snapshot.revision }
}

const modelLayer = (models: CloudflareModels | undefined, catalog: ModelCatalogState) => {
  if (models === undefined) {
    const failed: Action = { kind: "fail", error: "no model is configured", failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({
      resolve: () => { throw new Error("no model is configured: set TARDIGRADE_CONFIG.models") },
      react: () => Effect.succeed(failed)
    })
  }
  const availableModels = (): ModelPolicy => {
    const snapshot = catalog.snapshot
    if (snapshot === undefined) return { allow: [] }
    const configured: ModelPolicy = {
      allow: snapshot.providers.flatMap((provider) =>
        models.providers[provider.id] !== undefined && provider.models.length > 0
          ? [{ provider: provider.id, model_ids: provider.models.map((model) => model.id) }]
          : []
      )
    }
    return { ...intersectModelPolicies([models, configured]), default: models.default }
  }
  return Layer.succeed(Infer, {
    resolve: (reference) => {
      const selected = selectedModelFrom(models, catalog, reference)
      return {
        model: selected.reference,
        models: availableModels(),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.metadata.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    react: (request, key) => {
      if (request.model === undefined) return Effect.succeed({ kind: "fail" as const, error: "the actor selected no model", failure: { cause: "inference_error" as const, attempts: 0 } })
      const selectedModel = selectedModelFrom(models, catalog, request.model)
      const selected = infer({
        baseUrl: selectedModel.provider.baseUrl,
        apiKey: selectedModel.provider.apiKey,
        model: request.model.model_id,
        protocol: selectedModel.provider.protocol,
        provider: request.model.provider,
        ...(selectedModel.provider.region === undefined ? {} : { region: selectedModel.provider.region }),
        contextWindowTokens: selectedModel.contextWindowTokens,
        ...(selectedModel.metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: selectedModel.metadata.maxOutputTokens }),
        ...(selectedModel.metadata.pricing === undefined ? {} : { pricing: selectedModel.metadata.pricing })
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

const modelCatalogLoadPolicyOf = (raw: string | undefined): ModelCatalogLoadPolicy => {
  const selected = raw ?? DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY
  if (selected === "cache-first" || selected === "refresh") return selected
  throw new Error(`TARDIGRADE_MODEL_CATALOG_LOAD_POLICY must be "cache-first" or "refresh", got ${JSON.stringify(raw)}`)
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

const sandboxTransportOf = (raw: string | undefined): WorkerLoaderSandboxTransport => {
  const selected = raw ?? "capability"
  if (selected === "capability" || selected === "replay") return selected
  throw new Error(`TARDIGRADE_SANDBOX_TRANSPORT must be "capability" or "replay", got ${JSON.stringify(raw)}`)
}

function defaultAssemblyOf(
  env: Env,
  models: CloudflareModels | undefined,
  catalog: ModelCatalogState
) {
  const fireRatio = optionalRatio(env.TARDIGRADE_COMPACTION_FIRE_RATIO, "TARDIGRADE_COMPACTION_FIRE_RATIO")
  const keepRatio = optionalRatio(env.TARDIGRADE_COMPACTION_KEEP_RATIO, "TARDIGRADE_COMPACTION_KEEP_RATIO")
  const snapshot = catalog.snapshot
  const availability = providerAvailabilityFromModels(models)
  const agentCatalog = snapshot === undefined
    ? undefined
    : {
        providers: (query: Parameters<typeof providersPageOf>[2]) => {
          const effective = applyModelPolicy(models ?? { allow: "*" }, query?.models ?? {})
          return providersPageOf(snapshot, availability, { ...query, models: effective, policy: effective })
        },
        models: (query: Parameters<typeof modelsPageOf>[2]) => {
          const effective = applyModelPolicy(models ?? { allow: "*" }, query?.models ?? {})
          return modelsPageOf(snapshot, availability, { ...query, models: effective, policy: effective })
        }
      }
  return actor({
    name: DEFAULT_ACTOR_NAME,
    methods: agentMethods,
    components: [inferAgent([
      budget([codeMode([
        agentsPackage(agentCatalog === undefined ? {} : { catalog: agentCatalog }),
        workspacePackage(),
        fetchPackage()
      ])]),
      compaction({
        ...(models === undefined ? {} : {
          contextWindowTokens: (model: ModelRef | undefined) =>
            selectedModelFrom(models, catalog, model ?? models.default).contextWindowTokens
        }),
        ...(fireRatio === undefined ? {} : { fireRatio }),
        ...(keepRatio === undefined ? {} : { keepRatio })
      }),
      outputValidateOnce
    ])]
  })
}

const assemblyOf = (
  name: string,
  env: Env,
  models: CloudflareModels | undefined,
  catalog: ModelCatalogState
): DefaultAssembly | undefined => {
  if (mountedActor !== undefined) return mountedActor.name === name ? mountedActor.actor : undefined
  if (name !== DEFAULT_ACTOR_NAME) return undefined
  return defaultAssemblyOf(env, models, catalog)
}

const methodsOf = (name: string): ActorMethods | undefined => {
  if (mountedActor !== undefined) return mountedActor.name === name ? mountedActor.methods : undefined
  return name === DEFAULT_ACTOR_NAME ? agentMethods : undefined
}

// ActorHost runs one actor graph over one SQLite-backed Durable Object.
export class ActorHost extends DurableObject<Env> {
  private runtime: Promise<CloudflareHost> | undefined
  private catalogState: Promise<ModelCatalogState> | undefined
  private driving: Promise<void> | undefined
  private principal: string | undefined
  private readonly alarmPolicy: AlarmPolicy
  private readonly sandboxCalls = new Map<
    string,
    (ordinal: number, packageName: string, method: string, args: unknown) => Promise<SandboxCallOutcome>
  >()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS actor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    this.alarmPolicy = alarmPolicyOf(env.TARDIGRADE_ALARM_DELAY_MILLIS === undefined
      ? {}
      : { recoveryDelayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS") })
  }

  async init(name: string): Promise<void> {
    if (!deployed(name)) throw new Error(`actor ${JSON.stringify(name)} is not deployed`)
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_meta (key, value) VALUES ('principal', ?)", name)
    const principal = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").one().value
    if (principal !== name) throw new Error("actor host name does not match its durable identity")
    this.principal ??= principal
  }

  private name(): string {
    if (this.principal !== undefined) return this.principal
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM actor_meta WHERE key = 'principal'").toArray()[0]
    if (row === undefined) throw new Error("actor host has not been initialized")
    return this.principal = row.value
  }

  async catalog(): Promise<ModelCatalogState> {
    this.catalogState ??= Effect.runPromise(loadModelCatalog({
      sourceUrl: this.env.TARDIGRADE_MODEL_CATALOG_URL?.trim() || DEFAULT_MODEL_CATALOG_URL,
      timeoutMillis: positiveInteger(
        this.env.TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS,
        DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS,
        "TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS"
      ),
      policy: modelCatalogLoadPolicyOf(this.env.TARDIGRADE_MODEL_CATALOG_LOAD_POLICY)
    }).pipe(
      Effect.provide(layerCloudflareModelCatalogRepository(this.ctx.storage)),
      Effect.tap((catalog) => Effect.all([
        catalog.refreshError === undefined ? Effect.void : Effect.logWarning(`model catalog refresh failed: ${catalog.refreshError}`),
        catalog.cacheError === undefined ? Effect.void : Effect.logWarning(`model catalog cache failed: ${catalog.cacheError}`)
      ], { discard: true }))
    ))
    return this.catalogState
  }

  async sandboxCallBatch(
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    const call = this.sandboxCalls.get(execution)
    if (call === undefined) throw new Error(`sandbox execution ${JSON.stringify(execution)} is unavailable`)
    return Promise.all(calls.map((entry) => call(entry.ordinal, entry.packageName, entry.method, entry.args)))
  }

  private async openHost(): Promise<CloudflareHost> {
    const models = modelsFrom(this.env)
    const catalog: ModelCatalogState = models === undefined
      ? { refreshError: "no model is configured" }
      : await this.catalog()
    const principal = this.name()
    const selectedAssembly = assemblyOf(principal, this.env, models, catalog)
    if (selectedAssembly === undefined) throw new Error(`actor ${JSON.stringify(principal)} is not deployed`)
    const sandboxCpuMs = optionalNonNegativeInteger(this.env.TARDIGRADE_SANDBOX_CPU_MILLIS, "TARDIGRADE_SANDBOX_CPU_MILLIS")
    const sandboxSubRequests = optionalNonNegativeInteger(
      this.env.TARDIGRADE_SANDBOX_SUBREQUESTS,
      "TARDIGRADE_SANDBOX_SUBREQUESTS"
    )
    const sandboxLimits: WorkerLoaderSandboxLimits = {
      ...(sandboxCpuMs === undefined ? {} : { cpuMs: sandboxCpuMs }),
      ...(sandboxSubRequests === undefined ? {} : { subRequests: sandboxSubRequests })
    }
    const actorName = this.ctx.id.name
    if (actorName === undefined) throw new Error("actor host requires a named durable object")
    const sandboxLayer = layerWorkerLoaderSandbox(
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
        transport: sandboxTransportOf(this.env.TARDIGRADE_SANDBOX_TRANSPORT),
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
            if (!deployed(destination.actor)) throw new Error(`actor ${JSON.stringify(destination.actor)} is not deployed`)
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
    return createCloudflareHost({
      storage: this.ctx.storage,
      principal,
      actorFor: (lane) => threadOf(lane) === undefined ? undefined : selectedAssembly,
      layersFor: () => Layer.mergeAll(modelLayer(models, catalog), FetchHttpClient.layer, sandboxLayer),
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
  }

  private host(): Promise<CloudflareHost> {
    this.runtime ??= this.openHost()
    return this.runtime
  }

  private async arm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
  }

  private async synchronizeAlarm(host: CloudflareHost): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const at = scheduledAlarmAt(
      current,
      await host.resting(),
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      await host.nextMethodDeadline()
    )
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current !== at) {
      await this.ctx.storage.setAlarm(at)
    }
  }

  private async commitTurn(): Promise<void> {
    await scheduler.wait(0)
  }

  // accept stages the work and recovery alarm, crosses their commit turn, and starts reconciliation in that order (tla/DurableExecution.tla, CoveredBeforeDrive).
  private async accept(host: CloudflareHost, stage: () => Promise<void>): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    await stage()
    const at = scheduledAlarmAt(
      current,
      false,
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      await host.nextMethodDeadline()
    )
    if (at !== null && current !== at) await this.ctx.storage.setAlarm(at)
    await this.commitTurn()
    this.kick(host)
  }

  // kick starts reconciliation while the Durable Object is active and leaves its alarm armed until the host rests (test/actor.workers.ts, "a mounted actor exposes durable methods").
  private kick(host: CloudflareHost): void {
    if (this.driving !== undefined) return
    let failed = false
    const driving = (async () => {
      try {
        await host.drive()
        await this.synchronizeAlarm(host)
      } catch (cause) {
        failed = true
        console.error("actor drive failed; the alarm remains armed", cause)
      }
    })()
    this.driving = driving
    void driving.finally(() => {
      if (this.driving === driving) this.driving = undefined
      if (!failed && host.work() > 0) this.kick(host)
    })
  }

  async append(thread: string, event: Event): Promise<void> {
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    const host = await this.host()
    await this.accept(host, () => host.stageRoot(host.self(laneOf(thread)), stamped))
  }

  async deliver(envelope: ActorEnvelope): Promise<void> {
    if (envelope.link.target.actor !== this.name()) throw new Error("delivery target does not match actor host")
    const host = await this.host()
    await this.accept(host, () => host.stage(envelope))
  }

  async events(thread: string): Promise<ReadonlyArray<Event>> {
    return (await this.host()).read(laneOf(thread))
  }

  async threads(): Promise<ReadonlyArray<ThreadSummary>> {
    const host = await this.host()
    const logs = new Map<string, ReadonlyArray<Event>>()
    for (const lane of await host.lanes()) {
      const id = threadOf(lane)
      if (id !== undefined) logs.set(id, await host.read(lane))
    }
    return flattenThreads(treeOf(logs))
  }

  async status(): Promise<{ readonly status: "resting" | "driving"; readonly dirty: number }> {
    const host = await this.host()
    return { status: await host.resting() ? "resting" : "driving", dirty: host.work() }
  }

  async alarm(): Promise<void> {
    const at = Date.now()
    const host = await this.host()
    await this.arm()
    await this.commitTurn()
    await host.recordAlarm(at)
    await host.recover()
    await this.synchronizeAlarm(host)
  }
}

const actorStub = async (
  env: Env,
  name: string
): Promise<DurableObjectStub<ActorHost> | undefined> => {
  if (!deployed(name)) return undefined
  const stub = env.ACTORS.getByName(name)
  await stub.init(name)
  return stub
}

class WorkerEnv extends Context.Service<WorkerEnv, Env>()("tardigrade/cloudflare/WorkerEnv") {}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

const jsonSchemaOf = (schema: Schema.Constraint): unknown => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
}

const methodEventOf = (
  method: ActorMethods[string],
  call: { readonly id: string; readonly input: unknown; readonly at: number }
): { readonly event: Event } | { readonly error: string } => {
  try {
    return { event: method.eventOf(call) }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

const authorized = (request: HttpServerRequest.HttpServerRequest, env: Env): boolean =>
  env.TARDIGRADE_TOKEN !== undefined && request.headers.authorization === `Bearer ${env.TARDIGRADE_TOKEN}`

const guard = (request: HttpServerRequest.HttpServerRequest, env: Env) => {
  if (env.TARDIGRADE_TOKEN === undefined) return json({ error: "authentication is not configured" }, 503)
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401)
  return undefined
}

const catalogQueryOf = (request: HttpServerRequest.HttpServerRequest) => {
  const query = new URL(request.url, "http://worker").searchParams
  const value = (name: string): string | undefined => query.get(name) ?? undefined
  const limit = value("limit")
  return {
    availability: catalogChoiceOf(query.get("availability"), "availability", CATALOG_AVAILABILITY_FILTERS),
    cursor: value("cursor"),
    search: value("search"),
    ...(limit === undefined ? {} : { limit: Number(limit) })
  }
}

const catalogChoiceOf = <const Values extends ReadonlyArray<string>>(
  raw: string | null,
  name: string,
  values: Values
): Values[number] | undefined => {
  if (raw === null) return undefined
  if (values.includes(raw)) return raw as Values[number]
  throw new Error(`catalog ${name} must be one of ${values.join(", ")}`)
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
    return json(yield* Effect.promise(async () => (await actorStub(env, deployedActor))!.status()))
  })),
  HttpRouter.route("GET", "/v1/providers", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const env = yield* WorkerEnv
    return yield* Effect.tryPromise({
      try: async () => {
        const stub = await actorStub(env, deployedActor)
        if (stub === undefined) throw new Error("no actor is deployed")
        const catalog = await stub.catalog()
        if (catalog.snapshot === undefined) {
          throw new Error(catalog.refreshError ?? catalog.cacheError ?? "no validated model catalog is available")
        }
        return providersPageOf(catalog.snapshot, providerAvailabilityFrom(env), {
          ...catalogQueryOf(request),
          policy: modelPolicyFrom(env)
        })
      },
      catch: (cause) => cause instanceof Error ? cause.message : String(cause)
    }).pipe(Effect.match({
      onFailure: (error) => json({ error }, error.includes("catalog cursor") || error.includes("catalog limit") ? 400 : 503),
      onSuccess: (page) => json(page)
    }))
  })),
  HttpRouter.route("GET", "/v1/models", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const env = yield* WorkerEnv
    return yield* Effect.tryPromise({
      try: async () => {
        const stub = await actorStub(env, deployedActor)
        if (stub === undefined) throw new Error("no actor is deployed")
        const catalog = await stub.catalog()
        if (catalog.snapshot === undefined) {
          throw new Error(catalog.refreshError ?? catalog.cacheError ?? "no validated model catalog is available")
        }
        const query = new URL(request.url, "http://worker").searchParams
        return modelsPageOf(catalog.snapshot, providerAvailabilityFrom(env), {
          ...catalogQueryOf(request),
          policy: modelPolicyFrom(env),
          provider: query.get("provider") ?? undefined,
          sort: catalogChoiceOf(query.get("sort"), "sort", MODEL_CATALOG_PRICE_SORTS),
          order: catalogChoiceOf(query.get("order"), "order", MODEL_CATALOG_SORT_ORDERS),
          unpriced: catalogChoiceOf(query.get("unpriced"), "unpriced", MODEL_CATALOG_UNPRICED_ORDERS)
        })
      },
      catch: (cause) => cause instanceof Error ? cause.message : String(cause)
    }).pipe(Effect.match({
      onFailure: (error) => json({ error }, error.startsWith("catalog ") ? 400 : 503),
      onSuccess: (page) => json(page)
    }))
  })),
  HttpRouter.route("GET", "/v1/metadata", protectedRoute((_request, _env) =>
    Effect.succeed(json({ name: deployedActor, storage: { kind: "durable-object" } }))
  )),
  HttpRouter.route("GET", "/v1/methods", protectedRoute((_request, _env) =>
    Effect.gen(function* () {
      const methods = methodsOf(deployedActor)
      if (methods === undefined) return json({ error: "actor assembly is not deployed" }, 503)
      return json(Object.entries(methods).map(([name, method]) => ({
        name,
        inputSchema: jsonSchemaOf(method.input),
        outputSchema: jsonSchemaOf(method.output)
      })))
    })
  )),
  HttpRouter.route("PUT", "/v1/threads/:thread/methods/:method/calls/:call", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const thread = decodeURIComponent(params.thread ?? "")
      const methodName = decodeURIComponent(params.method ?? "")
      const call = decodeURIComponent(params.call ?? "")
      const method = methodsOf(actor)?.[methodName]
      if (method === undefined) return json({ error: "unknown method" }, 404)
      const input = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
      const at = yield* Clock.currentTimeMillis
      const decoded = methodEventOf(method, { id: call, input, at })
      if ("error" in decoded) return json({ error: decoded.error }, 400)
      const stub = yield* Effect.promise(() => actorStub(env, actor))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      yield* Effect.promise(() => stub.append(thread, decoded.event))
      return json({ thread, method: methodName, call }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/threads/:thread/methods/:method/calls/:call", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const thread = decodeURIComponent(params.thread ?? "")
      const methodName = decodeURIComponent(params.method ?? "")
      const call = decodeURIComponent(params.call ?? "")
      const method = methodsOf(actor)?.[methodName]
      if (method === undefined) return json({ error: "unknown method" }, 404)
      const stub = yield* Effect.promise(() => actorStub(env, actor))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      const events = yield* Effect.promise(() => stub.events(thread)).pipe(
        Effect.map((value) => value as ReadonlyArray<Event>)
      )
      const state = method.state(events, call)
      return state === undefined ? json({ error: "unknown method call" }, 404) : json(state)
    })
  )),
  HttpRouter.route("GET", "/v1/threads", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const stub = yield* Effect.promise(() => actorStub(env, deployedActor))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      return json(yield* Effect.promise(() => stub.threads()))
    })
  )),
  HttpRouter.route("POST", "/v1/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const thread = decodeURIComponent(params.thread ?? "")
      const stub = yield* Effect.promise(() => actorStub(env, actor))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      const event = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as Event | undefined
      if (typeof event !== "object" || event === null || typeof event.type !== "string" || event.type === "") {
        return json({ error: "event type is required" }, 400)
      }
      yield* Effect.promise(() => stub.append(thread, event))
      return json({ thread }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const thread = decodeURIComponent(params.thread ?? "")
      const stub = yield* Effect.promise(() => actorStub(env, actor))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      const url = new URL(request.url, "http://worker")
      const after = Number(url.searchParams.get("after") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 200)
      const types = url.searchParams.get("types")?.split(",")
      return yield* Effect.tryPromise({
        try: (): Promise<ReadonlyArray<Event>> => stub.events(thread),
        catch: (cause) => cause instanceof Error ? cause.message : String(cause)
      }).pipe(Effect.match({
        onFailure: (error) => json({ error }, 500),
        onSuccess: (events) => events.length === 0
          ? json({ error: "unknown thread" }, 404)
          : json(events.map((event, index) => ({ seq: index + 1, event }))
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

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return webHandler(request, Context.make(WorkerEnv, env) as Context.Context<never>)
  }
} satisfies ExportedHandler<Env>

// cloudflareWorker mounts a defined actor into the Worker and its Durable Object host (test/actor.workers.ts, "a mounted actor exposes durable methods").
export const cloudflareWorker = <R, const Methods extends ActorMethods>(
  definition: Actor<R, Methods>
): ExportedHandler<Env> => {
  mountedActor = {
    name: definition.name,
    actor: definition as unknown as DefaultAssembly,
    methods: definition.methods
  }
  deployedActor = definition.name
  return worker
}

export default worker
