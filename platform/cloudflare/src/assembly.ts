import { cloudflareDirectory } from "./transport/directory"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { actor, agentMethods, agentsPackage, applyModelPolicy, budget, codeMode, compaction, fetchPackage, Infer, infer as inferAgent, intersectModelPolicies, modelAllowedBy, outputValidateOnce, workspacePackage, type ActorMethods, type InferenceObserver, type ModelPolicy, type ModelRef } from "tardie"
import type { Action } from "tardie/log/events"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import { infer } from "@clavia/tardigrade-model/model"
import type { ModelAdapterRegistry } from "@clavia/tardigrade-model/adapter"
import { DEFAULT_MODEL_CATALOG_URL } from "@clavia/tardigrade-model/metadata"
import { loadModelCatalog, type ModelCatalogLoadPolicy, type ModelCatalogState } from "@clavia/tardigrade-server/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-server/catalog-availability"
import { modelsPageOf, providersPageOf } from "@clavia/tardigrade-server/catalog-page"
import { canonicalModelConfig, modelConfigOf, type ModelConfig, type ModelProviderConfig } from "@clavia/tardigrade-server/config"
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

const DEFAULT_ACTOR_NAME = "default"
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

export type DefaultAssembly = ReturnType<typeof defaultAssemblyOf>

interface MountedActor {
  readonly allocation?: ThreadAllocationPolicy
  readonly threadAllocator?: typeof ThreadAllocator.Service
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

export let mountedActor: MountedActor | undefined
export let deployedActor = DEFAULT_ACTOR_NAME

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

export const deployed = (name: string): boolean => deployedActor === name
export const directory = cloudflareDirectory(deployed)

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

export const modelLayer = (
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

const optionalRatio = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1, got ${JSON.stringify(raw)}`)
  }
  return value
}

export const sandboxTransportOf = (raw: string | undefined): WorkerLoaderSandboxTransport => {
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

export const assemblyOf = (
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

export const methodsOf = (name: string): ActorMethods | undefined => {
  if (mountedActor !== undefined) return mountedActor.name === name ? mountedActor.methods : undefined
  return name === DEFAULT_ACTOR_NAME ? agentMethods : undefined
}

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

// mountActor installs the assembly shared by the HTTP entry point and Durable Objects.
export const mountActor = (value: MountedActor): void => {
  mountedActor = value
  deployedActor = value.name
}
