import { DurableObject } from "cloudflare:workers"
import { Clock, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { actor, agentMethods, agentsPackage, applyModelPolicy, budget, codeMode, compaction, fetchPackage, Infer, infer as inferAgent, intersectModelPolicies, modelAllowedBy, outputValidateOnce, workspacePackage, type Actor, type ActorMethods, type InferenceObserver, type ModelPolicy, type ModelRef } from "tardie"
import type { Action } from "tardie/log/events"
import {
  CATALOG_AVAILABILITY_FILTERS,
  ModelCatalog as ModelCatalogSchema,
  MODEL_CATALOG_PRICE_SORTS,
  MODEL_CATALOG_SORT_ORDERS,
  MODEL_CATALOG_UNPRICED_ORDERS,
  type ModelCatalog,
  InvocationSettled
} from "@clavia/tardigrade-client/contract"
import { infer } from "@clavia/tardigrade-model/model"
import {
  modelAdapters,
  type ModelAdapterRegistry
} from "@clavia/tardigrade-model/adapter"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"
import {
  loadModelCatalog,
  type ModelCatalogLoadPolicy,
  type ModelCatalogState
} from "@clavia/tardigrade-server/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-server/catalog-availability"
import { modelsPageOf, providersPageOf } from "@clavia/tardigrade-server/catalog-page"
import { canonicalModelConfig, modelConfigOf, type ModelConfig, type ModelProviderConfig } from "@clavia/tardigrade-server/config"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, eventLogFrom } from "@clavia/tardigrade-core/log"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import { directoryRoute } from "@clavia/tardigrade-core/communication/router"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import { invokedEventOf, isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import { ActorInstanceId, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import {
  actorEventsOf,
  actorEventKeyOf,
  actorThreadsOf,
  type ActorThreadRecord,
  type ThreadRequested,
} from "@clavia/tardigrade-core/actor"
import {
  actorInvocationContextFrom,
  actorMethodTimeoutOf,
  cancellationDispositionOf,
  cancellationRequested,
  cancellationRequestIdOf
} from "@clavia/tardigrade-core/method"
import { sameThreadAddress, type ChildPlacement } from "@clavia/tardigrade-core/thread"
import type { CommitObserver } from "@clavia/tardigrade-host/commit"
import { effect, restingActor, settleActor } from "@clavia/tardigrade-core/runtime"
import { actorFromProjections } from "@clavia/tardigrade-core/runtime"
import { completeTransitionProjection } from "@clavia/tardigrade-core/transition"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"
import {
  layerWorkerLoaderSandbox,
  type SandboxBridgeCall,
  type SandboxBridgeLease,
  type WorkerLoaderSandboxLimits,
  type WorkerLoaderSandboxTransport
} from "@clavia/tardigrade-worker-loader/sandbox"
import { alarmPolicyOf, armAt, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import {
  initializeCloudflareActorSchema,
  initializeCloudflareThreadSchema,
  CloudflareEventStore,
  type CloudflareThreadStorePolicy
} from "./storage"
import {
  createCloudflareThreadHost,
  type CloudflareThreadHost,
  type CloudflareThreadEnv,
  type CloudflarePorts
} from "./host"
import { layerCloudflareModelCatalogRepository } from "./catalog"
import { structuredWorkerConfigOf } from "./config"

export interface Env {
  readonly ACTORS: DurableObjectNamespace<ActorDO>
  readonly THREADS: DurableObjectNamespace<ThreadDO>
  readonly CATALOG_DB: D1Database
  readonly LOADER: WorkerLoader
  readonly TARDIGRADE_CONFIG?: unknown
  readonly TARDIGRADE_BACKGROUND_TASK_OWNER?: string
  readonly TARDIGRADE_TOKEN?: string
  readonly TARDIGRADE_MODEL_CATALOG_URL?: string
  readonly TARDIGRADE_MODEL_CATALOG_LOAD_POLICY?: string
  readonly TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS?: string
  readonly TARDIGRADE_ALARM_DELAY_MILLIS?: string
  readonly TARDIGRADE_COMPACTION_FIRE_RATIO?: string
  readonly TARDIGRADE_COMPACTION_KEEP_RATIO?: string
  readonly TARDIGRADE_SANDBOX_LOG_CAP_BYTES?: string
  readonly TARDIGRADE_SANDBOX_CPU_MILLIS?: string
  readonly TARDIGRADE_SANDBOX_SUBREQUESTS?: string
  readonly TARDIGRADE_SANDBOX_TRANSPORT?: string
}

const THREAD_PREFIX = "ag."
const actorThreadOf = (thread: string): string => thread.startsWith(THREAD_PREFIX) ? thread : `${THREAD_PREFIX}${thread}`
const threadIdOf = (thread: string): string | undefined =>
  thread.startsWith(THREAD_PREFIX) ? thread.slice(THREAD_PREFIX.length) : undefined

export interface ActorThreadNode {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly children: ReadonlyArray<ActorThreadNode>
}

const registeredKeyOf = (thread: string): string => `thread:registered:${thread}`

const actorSupervisorOf = (
  env: Env,
  identity: { readonly actor: string; readonly instance: string }
) => actorFromProjections({
  transitions: [completeTransitionProjection((events) => {
    const actorEvents = actorEventsOf(events)
    const registered = new Set(actorEvents.flatMap((event) => event.type === "ThreadRegistered" ? [event.thread] : []))
    const registrations = actorEvents.flatMap((event) => {
      if (event.type !== "ThreadRequested" || registered.has(event.thread)) return []
      return [effect({
        key: registeredKeyOf(event.thread),
        input: event,
        act: (request) => Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const stub = env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, request.thread))
            if (request.parentThread === undefined) {
              if (!(await stub.exists(identity.actor, identity.instance, request.thread))) {
                throw new Error(`root thread ${JSON.stringify(request.thread)} has no durable host`)
              }
            } else {
              await stub.commitCreation()
            }
          })
          return [{ type: "ThreadRegistered", thread: request.thread, at: yield* Clock.currentTimeMillis }]
        })
      })]
    })
    return registrations
  })],
  keyOf: actorEventKeyOf
})

const threadTreeOf = (rows: ReadonlyArray<ActorThreadRecord>): ReadonlyArray<ActorThreadNode> => {
  const entries = new Map<string, Omit<ActorThreadNode, "children">>()
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const row of rows) {
    const id = threadIdOf(row.thread)
    if (id === undefined) continue
    const parent = row.parentThread === undefined ? undefined : threadIdOf(row.parentThread)
    entries.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      depth: row.depth,
      ...(row.placement === null ? {} : { placement: row.placement })
    })
    if (parent === undefined) roots.push(id)
    else children.set(parent, [...children.get(parent) ?? [], id])
  }
  const visited = new Set<string>()
  const node = (id: string, ancestors: ReadonlySet<string>): ActorThreadNode => {
    if (ancestors.has(id)) throw new Error(`thread tree contains a cycle at ${JSON.stringify(id)}`)
    const entry = entries.get(id)
    if (entry === undefined) throw new Error(`thread tree is missing ${JSON.stringify(id)}`)
    visited.add(id)
    const next = new Set(ancestors).add(id)
    return {
      ...entry,
      children: [...children.get(id) ?? []].sort().map((child) => node(child, next))
    }
  }
  const tree = roots.sort().map((root) => node(root, new Set()))
  if (visited.size !== entries.size) throw new Error("thread tree contains an orphan or cycle")
  return tree
}
const actorObjectNameOf = (actor: string, instance: string): string => JSON.stringify([actor, instance])
const threadObjectNameOf = (actor: string, instance: string, thread: string): string => JSON.stringify([actor, instance, thread])

const DEFAULT_ACTOR_NAME = "default"
export const DEFAULT_CLOUDFLARE_EVENT_LIMIT = 200
export const CLOUDFLARE_CHILD_PLACEMENTS = ["independent"] as const satisfies ReadonlyArray<ChildPlacement>
export const DEFAULT_CLOUDFLARE_CHILD_PLACEMENT: ChildPlacement = "independent"

export const BACKGROUND_TASK_OWNERS = ["host", "request"] as const
export type BackgroundTaskOwner = typeof BACKGROUND_TASK_OWNERS[number]
export const DEFAULT_BACKGROUND_TASK_OWNER: BackgroundTaskOwner = "host"

// backgroundTaskOwnerOf validates which execution scope retains work after a Durable Object RPC returns.
export const backgroundTaskOwnerOf = (
  raw: string | undefined,
  fallback: BackgroundTaskOwner = DEFAULT_BACKGROUND_TASK_OWNER
): BackgroundTaskOwner => {
  if (raw === undefined) return fallback
  if (raw === "host" || raw === "request") return raw
  throw new Error(`TARDIGRADE_BACKGROUND_TASK_OWNER must be "host" or "request", got ${JSON.stringify(raw)}`)
}

// retainBackgroundTask assigns the task to the request when the host does not retain ongoing work after an RPC returns.
export const retainBackgroundTask = (
  scope: { waitUntil(task: Promise<unknown>): void },
  owner: BackgroundTaskOwner,
  task: Promise<unknown>
): void => {
  if (owner === "request") scope.waitUntil(task)
}

type DefaultAssembly = ReturnType<typeof defaultAssemblyOf>

interface MountedActor {
  readonly name: string
  readonly actor: DefaultAssembly
  readonly methods: ActorMethods
  readonly modelAdapters: ModelAdapterRegistry
  readonly modelScope?: DeploymentModelScope
  readonly inferenceObserverFor?: (context: CloudflareWorkerLayerContext<Env>) => InferenceObserver
  readonly commitObserverFor?: (context: CloudflareWorkerLayerContext<Env>) => CommitObserver
  readonly layersFor?: (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadEnv<never>
  readonly storeFor?: (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadStorePolicy
  readonly defaultChildPlacement: ChildPlacement
  readonly backgroundTaskOwner: BackgroundTaskOwner
}

let mountedActor: MountedActor | undefined
let deployedActor = DEFAULT_ACTOR_NAME

const EMPTY_MODEL_SCOPE: ModelCatalog = {
  source: "models.dev",
  revision: "empty",
  refreshedAt: 0,
  status: "cached",
  providers: []
}

export interface DeploymentModelScope {
  readonly configDigest: string
  readonly catalog: ModelCatalog
}

// modelScopeFrom validates the catalog snapshot embedded in a deployment model lock.
export const modelScopeFrom = (value: unknown): DeploymentModelScope => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("configDigest" in value) ||
    typeof value.configDigest !== "string" ||
    !("catalog" in value)
  ) {
    throw new Error("models.lock.json is invalid; run `tdg models lock`")
  }
  return { configDigest: value.configDigest, catalog: Schema.decodeUnknownSync(ModelCatalogSchema)(value.catalog) }
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

// modelCatalogForConfig rejects a deployment lock resolved from different model configuration.
export const modelCatalogForConfig = async (
  config: ModelConfig,
  scope: DeploymentModelScope
): Promise<ModelCatalog> => {
  if (scope.configDigest !== await sha256(canonicalModelConfig(config))) {
    throw new Error("models.lock.json does not match model configuration; run `tdg models lock`")
  }
  return scope.catalog
}

// DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS bounds a catalog refresh.
export const DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS = 10_000

// DEFAULT_CLOUDFLARE_MODEL_CATALOG_LOAD_POLICY refreshes the interpreter catalog once per Thread DO activation.
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

const modelConfigFrom = (env: Env): ModelConfig | undefined => {
  const rawModels = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)?.["models"]
  return rawModels === undefined ? undefined : modelConfigOf(rawModels)
}

const modelsFrom = (env: Env, parsed: ModelConfig | undefined): CloudflareModels | undefined => {
  if (parsed === undefined) return undefined
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
  scope: ModelCatalog,
  reference?: ModelRef
) => {
  const selected = reference ?? models.default
  if (!modelAllowedBy(models, selected)) throw new Error(`model ${selected.provider}/${selected.model_id} is excluded by the host model policy`)
  const provider = models.providers[selected.provider]
  if (provider === undefined) throw new Error(`provider ${JSON.stringify(selected.provider)} is not configured; update TARDIGRADE_CONFIG.models`)
  const binding = scope.providers.find((candidate) => candidate.id === selected.provider)
    ?.models.find((candidate) => candidate.id === selected.model_id)
  if (binding === undefined) throw new Error(`model ${selected.provider}/${selected.model_id} is absent from the deployment lock; run \`tdg models lock\``)
  const contextWindowTokens = binding.metadata.contextWindowTokens
  if (contextWindowTokens === undefined) {
    throw new Error(`model catalog has no context window for ${selected.provider}/${selected.model_id}`)
  }
  return { reference: selected, provider, metadata: binding.metadata, contextWindowTokens, catalogRevision: scope.revision }
}

const modelLayer = (
  models: CloudflareModels | undefined,
  scope: ModelCatalog,
  adapters: ModelAdapterRegistry,
  observer?: InferenceObserver
) => {
  if (models === undefined) {
    const failed: Action = { kind: "fail", error: "no model is configured", failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({
      resolve: () => { throw new Error("no model is configured: set TARDIGRADE_CONFIG.models") },
      react: () => Effect.succeed(failed)
    })
  }
  const availableModels = (): ModelPolicy => {
    const configured: ModelPolicy = {
      allow: scope.providers.flatMap((provider) =>
        models.providers[provider.id] !== undefined && provider.models.length > 0
          ? [{ provider: provider.id, model_ids: provider.models.map((model) => model.id) }]
          : []
      )
    }
    return { ...intersectModelPolicies([models, configured]), default: models.default }
  }
  return Layer.succeed(Infer, {
    resolve: (reference) => {
      const selected = selectedModelFrom(models, scope, reference)
      return {
        model: selected.reference,
        models: availableModels(),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.metadata.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    react: (request, key, signal) => {
      if (request.model === undefined) return Effect.succeed({ kind: "fail" as const, error: "the actor selected no model", failure: { cause: "inference_error" as const, attempts: 0 } })
      const selectedModel = selectedModelFrom(models, scope, request.model)
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
      }, adapters, observer === undefined ? {} : { observer })
      return Effect.flatMap(Infer, (model) => model.react(request, key, signal)).pipe(Effect.provide(selected))
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

const loadCloudflareCatalog = (env: Env): Promise<ModelCatalogState> => Effect.runPromise(loadModelCatalog({
  sourceUrl: env.TARDIGRADE_MODEL_CATALOG_URL?.trim() || DEFAULT_MODEL_CATALOG_URL,
  timeoutMillis: positiveInteger(
    env.TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS,
    DEFAULT_CLOUDFLARE_MODEL_CATALOG_TIMEOUT_MILLIS,
    "TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS"
  ),
  policy: modelCatalogLoadPolicyOf(env.TARDIGRADE_MODEL_CATALOG_LOAD_POLICY)
}).pipe(
  Effect.provide(layerCloudflareModelCatalogRepository(env.CATALOG_DB)),
  Effect.tap((catalog) => Effect.all([
    catalog.refreshError === undefined ? Effect.void : Effect.logWarning(`model catalog refresh failed: ${catalog.refreshError}`),
    catalog.cacheError === undefined ? Effect.void : Effect.logWarning(`model catalog cache failed: ${catalog.cacheError}`)
  ], { discard: true }))
))

let publicCatalogState: Promise<ModelCatalogState> | undefined

const publicCatalog = (env: Env): Promise<ModelCatalogState> => {
  publicCatalogState ??= loadCloudflareCatalog(env)
  return publicCatalogState
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
  scope: ModelCatalog,
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
            selectedModelFrom(models, scope, model ?? models.default).contextWindowTokens
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
  scope: ModelCatalog,
  catalog: ModelCatalogState
): DefaultAssembly | undefined => {
  if (mountedActor !== undefined) return mountedActor.name === name ? mountedActor.actor : undefined
  if (name !== DEFAULT_ACTOR_NAME) return undefined
  return defaultAssemblyOf(env, models, scope, catalog)
}

const methodsOf = (name: string): ActorMethods | undefined => {
  if (mountedActor !== undefined) return mountedActor.name === name ? mountedActor.methods : undefined
  return name === DEFAULT_ACTOR_NAME ? agentMethods : undefined
}

// ActorDO reconciles one actor instance from its durable event log.
export class ActorDO extends DurableObject<Env> {
  private schema: Promise<void> | undefined
  private eventStore: Promise<CloudflareEventStore> | undefined
  private actorName: string | undefined
  private actorInstance: string | undefined
  private readonly database = ManagedRuntime.make(SqliteClient.layer({ storage: this.ctx.storage }))
  private readonly alarmPolicy: AlarmPolicy

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.alarmPolicy = alarmPolicyOf(env.TARDIGRADE_ALARM_DELAY_MILLIS === undefined
      ? {}
      : { recoveryDelayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS") })
  }

  async init(name: string, instance: string): Promise<void> {
    if (!deployed(name)) throw new Error(`actor ${JSON.stringify(name)} is not deployed`)
    if (!Schema.is(ActorInstanceId)(instance)) throw new Error("invalid actor instance id")
    this.schema ??= this.database.runPromise(initializeCloudflareActorSchema)
    await this.schema
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_identity (singleton, actor, instance) VALUES (1, ?, ?)", name, instance)
    const identity = this.identity()
    if (identity.actor !== name) throw new Error("actor definition does not match the durable host identity")
    if (identity.instance !== instance) throw new Error("actor instance does not match the durable host identity")
  }

  async exists(name: string, instance: string): Promise<boolean> {
    const table = this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'actor_identity'"
    ).toArray()[0]
    if (table === undefined) return false
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string }>(
      "SELECT actor, instance FROM actor_identity WHERE singleton = 1"
    ).toArray()[0]
    return row?.actor === name && row.instance === instance
  }

  private identity(): { readonly actor: string; readonly instance: string } {
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string }>(
      "SELECT actor, instance FROM actor_identity WHERE singleton = 1"
    ).toArray()[0]
    if (row === undefined) throw new Error("Actor DO has not been initialized")
    this.actorName ??= row.actor
    this.actorInstance ??= row.instance
    return row
  }

  private store(): Promise<CloudflareEventStore> {
    this.eventStore ??= this.database.runPromise(SqliteClient.SqliteClient).then(
      (sql) => new CloudflareEventStore(sql, actorEventKeyOf)
    )
    return this.eventStore
  }

  private async events(): Promise<ReadonlyArray<Event>> {
    return this.database.runPromise((await this.store()).read)
  }

  private async threads(): Promise<ReadonlyArray<ActorThreadRecord>> {
    return actorThreadsOf(await this.events())
  }

  private async resting(): Promise<boolean> {
    return restingActor(actorSupervisorOf(this.env, this.identity()), await this.events())
  }

  private async synchronizeAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const at = scheduledAlarmAt(
      current,
      await this.resting(),
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      undefined
    )
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current !== at) {
      await this.ctx.storage.setAlarm(at)
    }
  }

  private async reconcile(): Promise<void> {
    const identity = this.identity()
    const store = await this.store()
    await this.database.runPromise(
      settleActor(actorSupervisorOf(this.env, identity)).pipe(
        Effect.provideService(EventLog, eventLogFrom(store))
      )
    )
    await this.ctx.storage.sync()
  }

  private async request(event: ThreadRequested): Promise<void> {
    await this.database.runPromise((await this.store()).append([event]))
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    await scheduler.wait(0)
    await this.reconcile()
    await this.synchronizeAlarm()
  }

  async createThread(thread: string): Promise<void> {
    const identity = this.identity()
    const existing = (await this.threads()).find((entry) => entry.thread === thread)
    if (existing !== undefined && existing.parentThread !== undefined) {
      throw new Error("a child thread cannot be recreated as a root")
    }
    const stub = this.env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, thread))
    await stub.init(identity.actor, identity.instance, thread)
    await this.request({ type: "ThreadRequested", thread, depth: 0, at: Date.now() })
  }

  // deliverChild records creation after the child log and actor supervisor accept the request (tla/ThreadCreation.tla, CreatedHasAccepted).
  async deliverChild(envelope: ActorEnvelope): Promise<void> {
    const identity = this.identity()
    const target = envelope.link.target
    const lineage = envelope.lineage
    if (lineage === undefined) throw new Error("child delivery requires lineage")
    if (target.actor !== identity.actor || target.instance !== identity.instance) {
      throw new Error("a child thread must inherit its actor instance")
    }
    if (!isThreadAddress(envelope.link.source) || !sameThreadAddress(envelope.link.source, lineage.parent)) {
      throw new Error("a child thread lineage must match its delivery source")
    }
    const threads = await this.threads()
    const parent = threads.find((entry) => entry.thread === lineage.parent.thread)
    if (parent === undefined || parent.state !== "registered") throw new Error("a child thread requires a registered parent")
    if (lineage.depth !== Number(parent.depth) + 1) throw new Error("a child thread depth must follow its parent")
    const existing = threads.find((entry) => entry.thread === target.thread)
    const placement = lineage.placement ?? null
    if (existing !== undefined && (
      existing.parentThread !== lineage.parent.thread ||
      Number(existing.depth) !== lineage.depth ||
      existing.placement !== placement
    )) {
      throw new Error("a child thread already has different lineage")
    }
    const stub = this.env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, target.thread))
    await stub.init(identity.actor, identity.instance, target.thread)
    await stub.stageCreation(envelope)
    await this.request({
      type: "ThreadRequested",
      thread: target.thread,
      parentThread: lineage.parent.thread,
      depth: lineage.depth,
      ...(placement === null ? {} : { placement }),
      at: Date.now()
    })
  }

  async threadTree(): Promise<ReadonlyArray<ActorThreadNode>> {
    const entries = (await this.threads()).filter((entry) => entry.state === "registered")
    return threadTreeOf(entries)
  }

  async alarm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    await scheduler.wait(0)
    await this.reconcile()
    await this.synchronizeAlarm()
  }
}

// ThreadDO runs one thread over one SQLite-backed Durable Object.
export class ThreadDO extends DurableObject<Env> {
  private schema: Promise<void> | undefined
  private runtime: Promise<CloudflareThreadHost> | undefined
  private driving: Promise<void> | undefined
  private actorName: string | undefined
  private actorInstance: string | undefined
  private threadId: string | undefined
  private readonly alarmPolicy: AlarmPolicy
  private readonly backgroundTaskOwner: BackgroundTaskOwner
  private readonly sandboxCalls = new Map<
    string,
    (ordinal: number, packageName: string, method: string, args: unknown) => Promise<SandboxCallOutcome>
  >()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.alarmPolicy = alarmPolicyOf(env.TARDIGRADE_ALARM_DELAY_MILLIS === undefined
      ? {}
      : { recoveryDelayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS") })
    this.backgroundTaskOwner = backgroundTaskOwnerOf(
      env.TARDIGRADE_BACKGROUND_TASK_OWNER,
      mountedActor?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER
    )
  }

  async init(name: string, instance: string, thread: string): Promise<void> {
    if (!deployed(name)) throw new Error(`actor ${JSON.stringify(name)} is not deployed`)
    if (!Schema.is(ActorInstanceId)(instance)) throw new Error("invalid actor instance id")
    this.schema ??= Effect.runPromise(initializeCloudflareThreadSchema.pipe(
      Effect.provide(SqliteClient.layer({ storage: this.ctx.storage }))
    ))
    await this.schema
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO thread_identity (singleton, actor, instance, thread) VALUES (1, ?, ?, ?)",
      name,
      instance,
      thread
    )
    const identity = this.identity()
    if (identity.actor !== name) throw new Error("actor definition does not match the Thread DO identity")
    if (identity.instance !== instance) throw new Error("actor instance does not match the Thread DO identity")
    if (identity.thread !== thread) throw new Error("thread does not match the Thread DO identity")
  }

  async exists(name: string, instance: string, thread: string): Promise<boolean> {
    const table = this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'thread_identity'"
    ).toArray()[0]
    if (table === undefined) return false
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string; thread: string }>(
      "SELECT actor, instance, thread FROM thread_identity WHERE singleton = 1"
    ).toArray()[0]
    return row?.actor === name && row.instance === instance && row.thread === thread
  }

  private initialized(): boolean {
    return this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'thread_identity'"
    ).toArray()[0] !== undefined
  }

  private identity(): { readonly actor: string; readonly instance: string; readonly thread: string } {
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string; thread: string }>(
      "SELECT actor, instance, thread FROM thread_identity WHERE singleton = 1"
    ).toArray()[0]
    if (row === undefined) throw new Error("Thread DO has not been initialized")
    this.actorName ??= row.actor
    this.actorInstance ??= row.instance
    this.threadId ??= row.thread
    return row
  }

  private name(): string {
    return this.actorName ?? this.identity().actor
  }

  private instance(): string {
    return this.actorInstance ?? this.identity().instance
  }

  private thread(): string {
    return this.threadId ?? this.identity().thread
  }

  async sandboxCallBatch(
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    const call = this.sandboxCalls.get(execution)
    if (call === undefined) throw new Error(`sandbox execution ${JSON.stringify(execution)} is unavailable`)
    return Promise.all(calls.map((entry) => call(entry.ordinal, entry.packageName, entry.method, entry.args)))
  }

  private async openHost(): Promise<CloudflareThreadHost> {
    const modelConfig = modelConfigFrom(this.env)
    const deployedScope = mountedActor?.modelScope
    if (modelConfig !== undefined && deployedScope === undefined) {
      throw new Error("model configuration requires models.lock.json; run `tdg models lock`")
    }
    const modelScope = modelConfig === undefined || deployedScope === undefined
      ? EMPTY_MODEL_SCOPE
      : await modelCatalogForConfig(modelConfig, deployedScope)
    const models = modelsFrom(this.env, modelConfig)
    const adapters = mountedActor?.modelAdapters ?? modelAdapters()
    for (const provider of Object.values(models?.providers ?? {})) adapters.resolve(provider.protocol)
    const catalog: ModelCatalogState = models === undefined ? { refreshError: "no model is configured" } : { snapshot: modelScope }
    const actorName = this.name()
    const actorInstance = this.instance()
    const selectedAssembly = assemblyOf(actorName, this.env, models, modelScope, catalog)
    if (selectedAssembly === undefined) throw new Error(`actor ${JSON.stringify(actorName)} is not deployed`)
    const currentThread = this.thread()
    const sandboxCpuMs = optionalNonNegativeInteger(this.env.TARDIGRADE_SANDBOX_CPU_MILLIS, "TARDIGRADE_SANDBOX_CPU_MILLIS")
    const sandboxSubRequests = optionalNonNegativeInteger(
      this.env.TARDIGRADE_SANDBOX_SUBREQUESTS,
      "TARDIGRADE_SANDBOX_SUBREQUESTS"
    )
    const sandboxLimits: WorkerLoaderSandboxLimits = {
      ...(sandboxCpuMs === undefined ? {} : { cpuMs: sandboxCpuMs }),
      ...(sandboxSubRequests === undefined ? {} : { subRequests: sandboxSubRequests })
    }
    const durableObjectName = this.ctx.id.name
    if (durableObjectName === undefined) throw new Error("Thread DO requires a named Durable Object")
    const sandboxLayer = layerWorkerLoaderSandbox(
      this.env.LOADER,
      (call): SandboxBridgeLease => {
        const execution = crypto.randomUUID()
        this.sandboxCalls.set(execution, call)
        return {
          binding: this.env.THREADS.getByName(durableObjectName),
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
    const independentTransport: Transport<ThreadAddress, ActorEnvelope> = {
      name: "durable-object",
      send: (destination, envelope) => Effect.currentSpan.pipe(
        Effect.option,
        Effect.flatMap((current) => {
          const event = current._tag === "Some" && (envelope.event as { readonly traceparent?: unknown }).traceparent === undefined
            ? ({ ...envelope.event, traceparent: traceparentOf(current.value) } as Event)
            : envelope.event
          return Effect.promise(async () => {
            const placement = envelope.lineage?.placement ?? mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
            if (placement !== "independent") throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(placement)} thread placement`)
            if (!deployed(destination.actor)) throw new Error(`actor ${JSON.stringify(destination.actor)} is not deployed`)
            const delivered = {
              ...envelope,
              event,
              ...(envelope.lineage === undefined ? {} : { lineage: { ...envelope.lineage, placement } })
            }
            if (envelope.lineage !== undefined) {
              const directory = this.env.ACTORS.getByName(actorObjectNameOf(destination.actor, destination.instance))
              await directory.deliverChild(delivered)
              return
            }
            const stub = this.env.THREADS.getByName(threadObjectNameOf(destination.actor, destination.instance, destination.thread))
            await stub.deliver(delivered)
          })
        })
      )
    }
    const independentRoute = directoryRoute(
      independentTransport,
      mappedDirectory((id: ThreadAddress) => {
        return id.actor === actorName && id.instance === actorInstance && id.thread === currentThread ? undefined : id
      }),
      isActorEnvelope,
      (envelope) => envelope.link.target
    )
    const commitObserver = mountedActor?.commitObserverFor?.({ env: this.env, actorInstance, thread: currentThread })
    return createCloudflareThreadHost({
      storage: this.ctx.storage,
      actorName,
      actorInstance,
      thread: currentThread,
      actor: selectedAssembly,
      ...(commitObserver === undefined ? {} : { commitObserver }),
      retainCommitTask: (task: Promise<void>) => retainBackgroundTask(this.ctx, this.backgroundTaskOwner, task),
      layers: (() => {
        const thread = currentThread
        const observer = mountedActor?.inferenceObserverFor?.({ env: this.env, actorInstance, thread })
        const framework = Layer.mergeAll(modelLayer(models, modelScope, adapters, observer), FetchHttpClient.layer, sandboxLayer)
        const application = mountedActor?.layersFor?.({ env: this.env, actorInstance, thread })
        return application === undefined ? framework : Layer.mergeAll(framework, application)
      })(),
      routes: [independentRoute],
      ...(mountedActor?.storeFor === undefined ? {} : { store: mountedActor.storeFor({ env: this.env, actorInstance, thread: currentThread }) }),
      keyOf: selectedAssembly.keyOf
    })
  }

  private host(): Promise<CloudflareThreadHost> {
    this.runtime ??= this.openHost()
    return this.runtime
  }

  private async arm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
  }

  private async synchronizeAlarm(host: CloudflareThreadHost): Promise<void> {
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
  private async accept(host: CloudflareThreadHost, stage: () => Promise<void>): Promise<void> {
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
    host.publishStaged()
    this.kick(host)
  }

  // kick starts reconciliation while the Durable Object is active and leaves its alarm armed until the host rests (test/actor.workers.ts, "a mounted actor exposes durable methods").
  private kick(host: CloudflareThreadHost): void {
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
    retainBackgroundTask(this.ctx, this.backgroundTaskOwner, driving)
    void driving.finally(() => {
      if (this.driving === driving) this.driving = undefined
      if (!failed && host.work() > 0) this.kick(host)
    })
  }

  async append(thread: string, event: Event): Promise<boolean> {
    if (!this.initialized()) return false
    const actorThread = actorThreadOf(thread)
    const ownedThread = this.thread()
    if (ownedThread !== actorThread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    const host = await this.host()
    await this.accept(host, () => host.stageRoot(stamped))
    return true
  }

  private validateDelivery(envelope: ActorEnvelope): void {
    if (envelope.link.target.actor !== this.name()) throw new Error("delivery target does not match actor definition")
    if (envelope.link.target.instance !== this.instance()) throw new Error("delivery target does not match actor instance")
    if (envelope.lineage !== undefined && (
      envelope.lineage.parent.actor !== envelope.link.target.actor ||
      envelope.lineage.parent.instance !== envelope.link.target.instance
    )) {
      throw new Error("a child thread must inherit its actor instance")
    }
    const ownedThread = this.thread()
    if (envelope.link.target.thread !== ownedThread) {
      throw new Error("delivery target does not match actor thread")
    }
  }

  async stageCreation(envelope: ActorEnvelope): Promise<void> {
    this.validateDelivery(envelope)
    if (envelope.lineage === undefined) throw new Error("staged thread creation requires lineage")
    await (await this.host()).stage(envelope)
    await this.ctx.storage.sync()
  }

  async commitCreation(): Promise<void> {
    const host = await this.host()
    await this.arm()
    await this.commitTurn()
    host.publishStaged()
    this.kick(host)
  }

  async deliver(envelope: ActorEnvelope): Promise<void> {
    this.validateDelivery(envelope)
    const host = await this.host()
    await this.accept(host, () => host.stage(envelope))
  }

  async events(thread: string): Promise<ReadonlyArray<Event>> {
    const actorThread = actorThreadOf(thread)
    const ownedThread = this.thread()
    if (ownedThread !== actorThread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    return (await this.host()).read()
  }

  async queryEvents(
    thread: string,
    query: { readonly after: number; readonly limit: number; readonly types?: ReadonlyArray<string> }
  ): Promise<ReadonlyArray<{ readonly seq: number; readonly event: Event }>> {
    const actorThread = actorThreadOf(thread)
    const ownedThread = this.thread()
    if (ownedThread !== actorThread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    if (!Number.isSafeInteger(query.after) || query.after < 0) throw new Error("event query after must be a non-negative integer")
    if (!Number.isSafeInteger(query.limit) || query.limit < 0) throw new Error("event query limit must be a non-negative integer")
    if (query.limit === 0) return []
    const host = await this.host()
    const wanted = query.types === undefined ? undefined : new Set(query.types)
    const selected: Array<{ readonly seq: number; readonly event: Event }> = []
    let mark = query.after
    while (selected.length < query.limit) {
      const rows = await host.readPage(mark, query.limit)
      if (rows.length === 0) break
      for (const row of rows) {
        if (wanted === undefined || wanted.has(row.event.type)) selected.push(row)
        if (selected.length === query.limit) break
      }
      mark = rows[rows.length - 1]!.seq
      if (rows.length < query.limit) break
    }
    return selected
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
  name: string,
  instance: string,
  create: boolean
): Promise<DurableObjectStub<ActorDO> | undefined> => {
  if (!deployed(name)) return undefined
  const stub = env.ACTORS.getByName(actorObjectNameOf(name, instance))
  if (!create && !(await stub.exists(name, instance))) return undefined
  if (create) await stub.init(name, instance)
  return stub
}

const threadStub = async (
  env: Env,
  name: string,
  instance: string,
  thread: string
): Promise<DurableObjectStub<ThreadDO> | undefined> => {
  if (!deployed(name)) return undefined
  const targetThread = actorThreadOf(thread)
  const stub = env.THREADS.getByName(threadObjectNameOf(name, instance, targetThread))
  if (!(await stub.exists(name, instance, targetThread))) return undefined
  return stub
}

const addressedThreadStub = (env: Env, name: string, instance: string, thread: string): DurableObjectStub<ThreadDO> =>
  env.THREADS.getByName(threadObjectNameOf(name, instance, actorThreadOf(thread)))

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
  call: Parameters<ActorMethods[string]["eventOf"]>[0]
): { readonly event: Event } | { readonly error: string } => {
  try {
    return { event: method.eventOf(call) }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

const selectedMethodTimeoutOf = (raw: string | null): { readonly timeoutMs: number } | { readonly error: string } => {
  try {
    return { timeoutMs: actorMethodTimeoutOf(raw === null ? undefined : Number(raw)) }
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
    return json({ status: "ready", actor: deployedActor })
  })),
  HttpRouter.route("GET", "/v1/providers", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const env = yield* WorkerEnv
    return yield* Effect.tryPromise({
      try: async () => {
        const catalog = await publicCatalog(env)
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
        const catalog = await publicCatalog(env)
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
        cancellable: method.cancellation !== undefined,
        timeoutMs: method.timeoutMs,
        inputSchema: jsonSchemaOf(method.input),
        outputSchema: jsonSchemaOf(method.output)
      })))
    })
  )),
  HttpRouter.route("PUT", "/v1/actors/:id", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const instance = params.id ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const stub = yield* Effect.promise(() => actorStub(env, deployedActor, instance, true))
      if (stub === undefined) return json({ error: "actor is not deployed" }, 503)
      return json({ actor: instance, definition: deployedActor })
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:id", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const instance = params.id ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const stub = yield* Effect.promise(() => actorStub(env, deployedActor, instance, false))
      return stub === undefined
        ? json({ error: "unknown actor" }, 404)
        : json({ actor: instance, definition: deployedActor })
    })
  )),
  HttpRouter.route("PUT", "/v1/actors/:id/threads/:thread", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const directory = yield* Effect.promise(() => actorStub(env, deployedActor, instance, false))
      if (directory === undefined) return json({ error: "unknown actor" }, 404)
      yield* Effect.promise(() => directory.createThread(actorThreadOf(thread)))
      return json({ actor: instance, thread })
    })
  )),
  HttpRouter.route("PUT", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const methodName = params.method ?? ""
      const call = params.call ?? ""
      const method = methodsOf(actor)?.[methodName]
      if (method === undefined) return json({ error: "unknown method" }, 404)
      const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
      if (stub === undefined) return json({ error: "unknown thread" }, 404)
      const events = yield* Effect.promise(() => stub.events(thread)).pipe(
        Effect.map((value) => value as ReadonlyArray<Event>)
      )
      const existing = events.map(actorInvocationContextFrom).find((context) =>
        context?.invocation.method === methodName && context.invocation.id === call &&
        context.invocation.epoch === 0 && context.deadlineAt !== undefined)
      if (existing?.deadlineAt !== undefined) {
        return json({ actor: instance, thread, method: methodName, call, deadlineAt: existing.deadlineAt }, 202)
      }
      const requestedTimeout = new URL(request.url, "http://worker").searchParams.get("timeoutMs")
      const selectedTimeout = selectedMethodTimeoutOf(requestedTimeout)
      if ("error" in selectedTimeout) return json({ error: selectedTimeout.error }, 400)
      const timeoutMs = selectedTimeout.timeoutMs
      if (timeoutMs > method.timeoutMs) {
        return json({ error: `timeoutMs cannot exceed method ${JSON.stringify(methodName)}'s declared ${method.timeoutMs}ms` }, 400)
      }
      const input = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
      const at = yield* Clock.currentTimeMillis
      const deadlineAt = at + timeoutMs
      if (!Number.isSafeInteger(deadlineAt)) return json({ error: "timeoutMs produces an invalid deadline" }, 400)
      const context = {
        invocation: { method: methodName, id: call, epoch: 0 },
        deadlineAt
      }
      const decoded = methodEventOf(method, { ...context, input, at })
      if ("error" in decoded) return json({ error: decoded.error }, 400)
      const appended = yield* Effect.promise(() => stub.append(thread, invokedEventOf(context, decoded.event)))
      if (!appended) return json({ error: "unknown thread" }, 404)
      return json({ actor: instance, thread, method: methodName, call, deadlineAt }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const methodName = params.method ?? ""
      const call = params.call ?? ""
      const method = methodsOf(actor)?.[methodName]
      if (method === undefined) return json({ error: "unknown method" }, 404)
      const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
      if (stub === undefined) return json({ error: "unknown thread" }, 404)
      const events = yield* Effect.promise(() => stub.events(thread)).pipe(
        Effect.map((value) => value as ReadonlyArray<Event>)
      )
      const epoch = method.currentEpoch(events, call)
      const state = method.state(events, { method: methodName, id: call, epoch })
      return state === undefined ? json({ error: "unknown method call" }, 404) : json(state)
    })
  )),
  HttpRouter.route("PUT", "/v1/actors/:id/threads/:thread/methods/:method/calls/:call/cancellation", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const methodName = params.method ?? ""
      const call = params.call ?? ""
      const method = methodsOf(actor)?.[methodName]
      if (method === undefined) return json({ error: "unknown method" }, 404)
      if (method.cancellation === undefined) return json({ error: "method does not declare cancellation" }, 400)
      const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
      if (stub === undefined) return json({ error: "unknown thread" }, 404)
      const events = yield* Effect.promise(() => stub.events(thread)).pipe(
        Effect.map((value) => value as ReadonlyArray<Event>)
      )
      const epoch = method.currentEpoch(events, call)
      const invocation = { method: methodName, id: call, epoch }
      if (method.state(events, invocation) === undefined) return json({ error: "unknown method call" }, 404)
      const disposition = cancellationDispositionOf(events, method, invocation)
      if (disposition === undefined) return json({ error: "unknown method call" }, 404)
      if (disposition === "settled") {
        return json(InvocationSettled.of(`Invocation ${JSON.stringify(call)} has settled and cannot be cancelled.`), 409)
      }
      if (disposition !== "requestable") {
        return json({ actor: instance, thread, method: methodName, call, status: disposition },
          disposition === "cancelled" ? 200 : 202)
      }
      const payload = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as { readonly reason?: unknown }
      if (payload.reason !== undefined && typeof payload.reason !== "string") return json({ error: "reason must be a string" }, 400)
      const at = yield* Clock.currentTimeMillis
      const appended = yield* Effect.promise(() => stub.append(thread, cancellationRequested({
        request: cancellationRequestIdOf(invocation),
        invocation,
        cause: "requested",
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        at
      })))
      if (!appended) return json({ error: "unknown thread" }, 404)
      return json({ actor: instance, thread, method: methodName, call, status: "requested" }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:id/threads", protectedRoute((_request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const instance = params.id ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const stub = yield* Effect.promise(() => actorStub(env, deployedActor, instance, false))
      if (stub === undefined) return json({ error: "unknown actor" }, 404)
      return json(yield* Effect.promise(() => stub.threadTree()))
    })
  )),
  HttpRouter.route("POST", "/v1/actors/:id/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const stub = addressedThreadStub(env, actor, instance, thread)
      const event = (yield* request.json.pipe(Effect.orElseSucceed(() => undefined))) as Event | undefined
      if (typeof event !== "object" || event === null || typeof event.type !== "string" || event.type === "") {
        return json({ error: "event type is required" }, 400)
      }
      const appended = yield* Effect.promise(() => stub.append(thread, event))
      if (!appended) return json({ error: "unknown thread" }, 404)
      return json({ actor: instance, thread }, 202)
    })
  )),
  HttpRouter.route("GET", "/v1/actors/:id/threads/:thread/events", protectedRoute((request, env) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params
      const actor = deployedActor
      const instance = params.id ?? ""
      const thread = params.thread ?? ""
      if (!Schema.is(ActorInstanceId)(instance)) return json({ error: "invalid actor instance id" }, 400)
      const stub = yield* Effect.promise(() => threadStub(env, actor, instance, thread))
      if (stub === undefined) return json({ error: "unknown thread" }, 404)
      const url = new URL(request.url, "http://worker")
      const after = Number(url.searchParams.get("after") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? DEFAULT_CLOUDFLARE_EVENT_LIMIT)
      if (!Number.isSafeInteger(after) || after < 0) return json({ error: "after must be a non-negative integer" }, 400)
      if (!Number.isSafeInteger(limit) || limit < 0) return json({ error: "limit must be a non-negative integer" }, 400)
      const types = url.searchParams.get("types")?.split(",").map((type) => type.trim()).filter((type) => type.length > 0)
      return yield* Effect.tryPromise({
        try: () => stub.queryEvents(thread, { after, limit, ...(types === undefined ? {} : { types }) }),
        catch: (cause) => cause instanceof Error ? cause.message : String(cause)
      }).pipe(Effect.match({
        onFailure: (error) => json({ error }, 500),
        onSuccess: (rows) => json(rows)
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

type CloudflareWorkerProvided = CloudflarePorts | Infer | HttpClient.HttpClient
type CloudflareApplicationRequirements<R> = Exclude<R, CloudflareWorkerProvided>

// CloudflareWorkerLayerContext exposes the Worker bindings and thread identity used to construct application services.
export interface CloudflareWorkerLayerContext<WorkerEnv extends Env = Env> {
  readonly env: WorkerEnv
  readonly actorInstance: string
  readonly thread: string
}

type CloudflareWorkerLayersFor<R, WorkerEnv extends Env> = (
  context: CloudflareWorkerLayerContext<WorkerEnv>
) => CloudflareThreadEnv<CloudflareApplicationRequirements<R>>
export type CloudflareWorkerStoreFor<WorkerEnv extends Env = Env> = (
  context: CloudflareWorkerLayerContext<WorkerEnv>
) => CloudflareThreadStorePolicy

interface CloudflareWorkerBaseOptions<WorkerEnv extends Env> {
  readonly modelAdapters?: ModelAdapterRegistry
  readonly modelScope?: DeploymentModelScope
  readonly inferenceObserverFor?: (context: CloudflareWorkerLayerContext<WorkerEnv>) => InferenceObserver
  readonly commitObserverFor?: (context: CloudflareWorkerLayerContext<WorkerEnv>) => CommitObserver
  readonly storeFor?: CloudflareWorkerStoreFor<WorkerEnv>
  readonly defaultChildPlacement?: ChildPlacement
  readonly backgroundTaskOwner?: BackgroundTaskOwner
}

// CloudflareWorkerOptions supplies every actor requirement the Worker does not bind itself.
export type CloudflareWorkerOptions<R, WorkerEnv extends Env = Env> =
  CloudflareWorkerBaseOptions<WorkerEnv> & ([CloudflareApplicationRequirements<R>] extends [never]
    ? { readonly layersFor?: CloudflareWorkerLayersFor<R, WorkerEnv> }
    : { readonly layersFor: CloudflareWorkerLayersFor<R, WorkerEnv> })

type CloudflareWorkerArguments<R, WorkerEnv extends Env> =
  [CloudflareApplicationRequirements<R>] extends [never]
    ? [options?: CloudflareWorkerOptions<R, WorkerEnv>]
    : [options: CloudflareWorkerOptions<R, WorkerEnv>]

// cloudflareWorker mounts a defined actor and its application layers into the Worker host (test/actor.workers.ts, "a mounted actor receives thread application services").
export const cloudflareWorker = <
  R,
  const Methods extends ActorMethods,
  WorkerEnv extends Env = Env
>(
  definition: Actor<R, Methods>,
  ...[options]: CloudflareWorkerArguments<R, WorkerEnv>
): ExportedHandler<WorkerEnv> => {
  const defaultChildPlacement = options?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
  if (!CLOUDFLARE_CHILD_PLACEMENTS.includes(defaultChildPlacement as "independent")) {
    throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(defaultChildPlacement)} thread placement`)
  }
  mountedActor = {
    name: definition.name,
    actor: definition as unknown as DefaultAssembly,
    methods: definition.methods,
    modelAdapters: options?.modelAdapters ?? modelAdapters(),
    ...(options?.modelScope === undefined ? {} : { modelScope: options.modelScope }),
    defaultChildPlacement,
    backgroundTaskOwner: options?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER,
    ...(options?.inferenceObserverFor === undefined ? {} : {
      inferenceObserverFor: options.inferenceObserverFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => InferenceObserver
    }),
    ...(options?.commitObserverFor === undefined ? {} : {
      commitObserverFor: options.commitObserverFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CommitObserver
    }),
    ...(options?.layersFor === undefined ? {} : {
      layersFor: options.layersFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadEnv<never>
    }),
    ...(options?.storeFor === undefined ? {} : {
      storeFor: options.storeFor as unknown as (context: CloudflareWorkerLayerContext<Env>) => CloudflareThreadStorePolicy
    })
  }
  deployedActor = definition.name
  return worker as ExportedHandler<WorkerEnv>
}

export default worker
