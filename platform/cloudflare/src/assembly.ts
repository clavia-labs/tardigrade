import { cloudflareDirectory } from "./transport/directory"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Infer, type InferenceObserver, type ModelPolicy, type ModelRef } from "@clavia/tardigrade-agent"
import type { Actor, ActorMethods } from "@clavia/tardigrade-core/actor"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import { modelLayer as hostModelLayer } from "@clavia/tardigrade-model/host"
import { modelAdapters, type ModelAdapterRegistry } from "@clavia/tardigrade-model/adapter"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"
import { loadModelCatalog, type ModelCatalogLoadPolicy, type ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog-availability"
import { canonicalModelConfig, modelConfigOf, type ModelConfig, type ModelProviderConfig } from "@clavia/tardigrade-model/config"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { type ThreadAllocationPolicy } from "@clavia/tardigrade-host/allocation"
import { type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { CommitObserver } from "@clavia/tardigrade-host/commit"
import { type WorkerLoaderSandboxTransport } from "@clavia/tardigrade-worker-loader/sandbox"
import { type CloudflareThreadStorePolicy } from "./storage"
import { type CloudflareThreadEnv, type CloudflarePorts } from "./host"
import { layerCloudflareModelCatalogRepository } from "./catalog"
import { structuredWorkerConfigOf } from "./config"
import type { Env } from "./env"

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

type MountedActor = CloudflareWorkerOptions<never> & {
  readonly actor: Actor<never>
  readonly modelAdapters: ModelAdapterRegistry
  readonly defaultChildPlacement: ChildPlacement
  readonly backgroundTaskOwner: BackgroundTaskOwner
}

export let mountedActor: MountedActor | undefined

export const EMPTY_MODEL_SCOPE: ModelCatalog = {
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

export const deployed = (name: string): boolean => mountedActor?.actor.name === name
export const directory = cloudflareDirectory(deployed)

type CloudflareProvider = ModelProviderConfig & {
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

export const modelConfigFrom = (env: Env): ModelConfig | undefined => {
  const rawModels = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)?.["models"]
  return rawModels === undefined ? undefined : modelConfigOf(rawModels)
}

export const modelsFrom = (env: Env, parsed: ModelConfig | undefined): CloudflareModels | undefined => {
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

export const providerAvailabilityFrom = (env: Env) => {
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

export const modelPolicyFrom = (env: Env): ModelPolicy => {
  const config = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)
  const parsed = modelConfigOf(config?.["models"] ?? { allow: "*" })
  return { ...(parsed.default === undefined ? {} : { default: parsed.default }), allow: parsed.allow }
}

const hostModelConfig = (models: CloudflareModels | undefined) => ({
  model: models ?? { allow: "*" as const, providers: {} },
  modelCredentials: Object.fromEntries(Object.values(models?.providers ?? {}).flatMap((provider) =>
    provider.env.map((name) => [name, provider.apiKey])))
})

export const modelLayer = (
  models: CloudflareModels | undefined,
  scope: ModelCatalog,
  adapters: ModelAdapterRegistry,
  observer?: InferenceObserver
) => Layer.effect(Infer, Effect.map(Infer, (binding) => ({
  ...binding,
  react: (request, key, signal) => models !== undefined && request.model === undefined
    ? Effect.succeed({ kind: "fail" as const, error: "the actor selected no model", failure: { cause: "inference_error" as const, attempts: 0 } })
    : binding.react(request, key, signal)
}))).pipe(Layer.provide(hostModelLayer(hostModelConfig(models), { snapshot: scope }, adapters, observer)))

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

export const publicCatalog = (env: Env): Promise<ModelCatalogState> => {
  publicCatalogState ??= loadCloudflareCatalog(env)
  return publicCatalogState
}

export const nonNegativeInteger = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  return value
}

export const optionalNonNegativeInteger = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined) return undefined
  return nonNegativeInteger(raw, 0, name)
}

export const sandboxTransportOf = (raw: string | undefined): WorkerLoaderSandboxTransport => {
  const selected = raw ?? "capability"
  if (selected === "capability" || selected === "replay") return selected
  throw new Error(`TARDIGRADE_SANDBOX_TRANSPORT must be "capability" or "replay", got ${JSON.stringify(raw)}`)
}

export const assemblyOf = (name: string): Actor<never> | undefined =>
  mountedActor?.actor.name === name ? mountedActor.actor : undefined

export const methodsOf = (name: string): ActorMethods | undefined =>
  mountedActor?.actor.name === name ? mountedActor.actor.methods : undefined

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
  readonly threadAllocator?: typeof ThreadAllocator.Service
  readonly allocation?: ThreadAllocationPolicy
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

export type CloudflareWorkerArguments<R, WorkerEnv extends Env> =
  [CloudflareApplicationRequirements<R>] extends [never]
    ? [options?: CloudflareWorkerOptions<R, WorkerEnv>]
    : [options: CloudflareWorkerOptions<R, WorkerEnv>]

// mountActor rejects a second assembly in the Worker module (test/actor.workers.ts, "rejects remounting without replacing the actor").
export const mountActor = <R, const Methods extends ActorMethods, WorkerEnv extends Env = Env>(
  definition: Actor<R, Methods>,
  ...[options]: CloudflareWorkerArguments<R, WorkerEnv>
): void => {
  if (mountedActor !== undefined) {
    throw new Error(`Worker already hosts actor ${JSON.stringify(mountedActor.actor.name)}; call defineWorkerHost once per module`)
  }
  const defaultChildPlacement = options?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
  if (!CLOUDFLARE_CHILD_PLACEMENTS.includes(defaultChildPlacement as "independent")) {
    throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(defaultChildPlacement)} thread placement`)
  }
  mountedActor = {
    ...options,
    actor: definition,
    modelAdapters: options?.modelAdapters ?? modelAdapters(),
    defaultChildPlacement,
    backgroundTaskOwner: options?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER
  } as unknown as MountedActor
}
