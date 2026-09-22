import { modelLockSourceOf, upgradeModelLock, type ModelLockSource } from "@clavia/tardigrade-model/lock-compat"
import type { ModelHostConfig } from "@clavia/tardigrade-model/selection"
import { lockedModelConfigOf, modelCatalogForConfig as lockedCatalogForConfig, ModelLock, modelLockService } from "@clavia/tardigrade-model/lock"
import { cloudflareDirectory } from "./transport/directory"
import { Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { type InferenceObserver } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { Actor, ActorMethods } from "@clavia/tardigrade-core/actor"
import { modelLayer as configuredModelLayer, type ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import type { ModelCatalog, ModelListing, ModelListingState } from "@clavia/tardigrade-model/catalog/schema"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog/availability"
import { modelCredentialsFrom, modelConfigOf, type ModelConfig } from "@clavia/tardigrade-model/config"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { type ThreadAllocationPolicy } from "@clavia/tardigrade-host/allocation"
import type { ThreadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import { type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { CommitObserver } from "@clavia/tardigrade-host/commit"
import { type WorkerLoaderSandboxTransport } from "@clavia/tardigrade-worker-loader/sandbox"
import { type CloudflareThreadStorePolicy } from "./storage"
import { type CloudflareThreadEnv, type CloudflarePorts } from "./host"
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

export type DeploymentModelScope = ModelLockSource
export const modelScopeFrom = modelLockSourceOf

// modelCatalogForConfig normalizes persisted locks before deriving discovery metadata (test/actor.workers.ts).
export const modelCatalogForConfig = async (config: ModelConfig, scope: DeploymentModelScope): Promise<ModelListing> => {
  const lock = await upgradeModelLock(scope, config)
  const { providers: _providers, ...policy } = lockedModelConfigOf(config, lock)
  return lockedCatalogForConfig(policy, lock)
}

// modelStateFrom obtains Worker inputs before shared lock resolution (test/actor.workers.ts).
export const modelStateFrom = async (env: Env) => {
  const models = structuredWorkerConfigOf(env.TARDIGRADE_CONFIG)?.["models"]
  const scope = mountedActor?.modelScope
  if (scope === undefined) return undefined
  const lock = await upgradeModelLock(scope, models)
  const model = lockedModelConfigOf(models, lock)
  const { providers: _providers, ...policy } = model
  const service = modelLockService(lock, policy)
  return { model, lock: Layer.succeed(ModelLock, service), catalog: { snapshot: await service.listing() } }
}

export const deployed = (name: string): boolean => mountedActor?.actor.name === name
export const directory = cloudflareDirectory(deployed)

export const modelsFrom = (env: Env, parsed: ModelConfig | undefined): ModelHostConfig => {
  const model = parsed ?? modelConfigOf({ allow: "*" })
  return { model, modelCredentials: modelCredentialsFrom(model, env as unknown as Readonly<Record<string, unknown>>) }
}

export const modelListingFrom = async (env: Env) => {
  const state = await modelStateFrom(env)
  const { model, modelCredentials } = modelsFrom(env, state?.model)
  return { ...state?.catalog, availability: providerAvailabilitiesOf(model, modelCredentials), policy: model }
}

export const modelLayer = (
  models: ModelHostConfig,
  observer?: InferenceObserver
) => configuredModelLayer({ credentials: models.modelCredentials, ...mountedActor?.model, ...(observer === undefined ? {} : { observer }), providerLayer: mountedActor?.model?.providerLayer ?? (() => { throw new Error("Configured Worker models require model.providerLayer in workerModelServices; import the selected tardie/model/providers module") }) })

export const publicCatalog = async (env: Env): Promise<ModelListingState> =>
  (await modelStateFrom(env))?.catalog ?? {}

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

type CloudflareWorkerProvided = CloudflarePorts | ModelLock | LanguageModel.LanguageModel | HttpClient.HttpClient
type CloudflareApplicationRequirements<R> = Exclude<R, CloudflareWorkerProvided>

// CloudflareWorkerLayerContext exposes the Worker bindings and thread identity used to construct application services.
export interface CloudflareWorkerLayerContext<WorkerEnv extends Env = Env> {
  readonly env: WorkerEnv
  readonly storage: DurableObjectStorage
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
  readonly streaming?: Partial<import("./transport/stream").CloudflareStreamPolicy>
  readonly authentication?: "bearer" | "none"
  readonly supervisor?: ThreadSupervisor
  readonly model?: ModelIntegrationOptions
  readonly threadAllocator?: typeof ThreadAllocator.Service
  readonly allocation?: ThreadAllocationPolicy
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
    defaultChildPlacement,
    backgroundTaskOwner: options?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER
  } as unknown as MountedActor
}
