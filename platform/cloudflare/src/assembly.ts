import { modelPolicyOf } from "@clavia/tardigrade-model/access"
import { modelLockOf, modelCatalogForConfig, modelConfigForPolicy, type ModelScope } from "@clavia/tardigrade-model/lock"
import { cloudflareDirectory } from "./transport/directory"
import { HttpClient } from "effect/unstable/http"
import { type InferenceObserver, type ModelPolicy, type ModelRef } from "@clavia/tardigrade-agent"
import type { LanguageModel } from "effect/unstable/ai"
import type { Actor, ActorMethods } from "@clavia/tardigrade-core/actor"
import { type ModelCatalog } from "@clavia/tardigrade-client/contract"
import { modelLayerFromLock as configuredModelLayer, type ModelIntegrationOptions } from "@clavia/tardigrade-model/host"
import { type ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog/availability"
import { type ModelConfig, type ModelProviderConfig } from "@clavia/tardigrade-model/config"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { type ThreadAllocationPolicy } from "@clavia/tardigrade-host/allocation"
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

export type DeploymentModelScope = ModelScope
export { modelCatalogForConfig } from "@clavia/tardigrade-model/lock"

// modelScopeFrom validates the model lock supplied to a Worker (test/actor.workers.ts).
export const modelScopeFrom = (value: unknown): DeploymentModelScope => modelLockOf(value)

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
  if (rawModels === undefined) return undefined
  const policy = modelPolicyOf(rawModels)
  const scope = mountedActor?.modelScope
  if (scope === undefined) throw new Error("model policy requires a ModelLock; supply workerModelServices scope")
  return modelConfigForPolicy(policy, scope)
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
  const parsed = modelConfigFrom(env) ?? { allow: "*" as const, providers: {} }
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
  const parsed = modelPolicyOf(config?.["models"] ?? { allow: "*" })
  return { ...(parsed.default === undefined ? {} : { default: parsed.default }), allow: parsed.allow }
}

const hostModelConfig = (models: CloudflareModels | undefined) => ({
  model: models ?? { allow: "*" as const, providers: {} },
  modelCredentials: Object.fromEntries(Object.values(models?.providers ?? {}).flatMap((provider) =>
    provider.env.map((name) => [name, provider.apiKey])))
})

export const modelLayer = (
  models: CloudflareModels | undefined,
  _scope: ModelCatalog,
  observer?: InferenceObserver
) => configuredModelLayer(hostModelConfig(models).model, hostModelConfig(models).modelCredentials, { ...mountedActor?.model, ...(observer === undefined ? {} : { observer }), providerLayer: mountedActor?.model?.providerLayer ?? (() => { throw new Error("Configured Worker models require model.providerLayer in workerModelServices; import the selected tardie/model/providers module") }) })

export const publicCatalog = async (env: Env): Promise<ModelCatalogState> => {
  const scope = mountedActor?.modelScope
  if (scope === undefined) return { snapshot: EMPTY_MODEL_SCOPE }
  const config = modelConfigFrom(env)
  if (config === undefined) return { snapshot: EMPTY_MODEL_SCOPE }
  return { snapshot: await modelCatalogForConfig(config, scope) }
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

type CloudflareWorkerProvided = CloudflarePorts | LanguageModel.LanguageModel | HttpClient.HttpClient
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
