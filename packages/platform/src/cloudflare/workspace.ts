import { Effect, Layer } from "effect"
import { ObjectStorage } from "@clavia/tardigrade-store"
import { WorkspaceError, type WorkspaceReadOptions } from "@clavia/tardigrade-libraries/workspace/index"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../shared/workspace/network"
import { sqlIdempotencyStore } from "../shared/workspace/idempotency-store"
import { Files, S3Mount, type S3GatewayBinding, type S3MountRequest } from "@cloudflare/sandbox"
import { workspaceObject } from "./workspace-object"
import { containerWorkspace, type ContainerWorkspacePolicy, type WorkspaceMount, type WorkspaceRelease } from "../shared/workspace/container"
import { workspaceNetworkRoutes } from "./workspace-network"
export { DEFAULT_WORKSPACE_NETWORK_POLICY, workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../shared/workspace/network"
export { WorkspaceNetworkProxy } from "./workspace-network"
export { S3Gateway } from "@cloudflare/sandbox"
export { containerWorkspace, DEFAULT_CONTAINER_WORKSPACE_POLICY, DEFAULT_WORKSPACE_RELEASE, type ContainerWorkspaceOptions, type ContainerWorkspacePolicy, type WorkspaceMount, type WorkspaceRelease } from "../shared/workspace/container"
export { mountedWorkspace } from "../shared/workspace/mounted"
export { remoteWorkspace, type RemoteWorkspace } from "../shared/workspace/remote"

export interface R2MountOptions {
  readonly flush: WorkspaceMount["flush"]
  readonly container: ConstructorParameters<typeof S3Mount>[0]
  readonly gateway: S3GatewayBinding
  readonly directory: string
  readonly endpoint: string
  readonly bucket: string
  readonly prefix: string
  readonly credentials: S3MountRequest["source"]["credentials"]
  readonly region?: string
  readonly access?: S3MountRequest["access"]
  readonly s3fsOptions?: S3MountRequest["s3fsOptions"]
}
export const DEFAULT_WORKSPACE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_R2_MOUNT_REGION = "auto"
export const DEFAULT_R2_MOUNT_ACCESS = "read-write" as const

// r2Mount maps a named bucket prefix onto a container directory through the Worker gateway.
export function r2Mount(options: R2MountOptions): WorkspaceMount {
  const mounts = new S3Mount(options.container, options.gateway)
  const request: S3MountRequest = {
    mountPath: options.directory,
    source: { type: "s3", endpoint: options.endpoint, region: options.region ?? DEFAULT_R2_MOUNT_REGION, bucket: options.bucket, credentials: options.credentials },
    keyPrefix: options.prefix.endsWith("/") ? options.prefix : `${options.prefix}/`, access: options.access ?? DEFAULT_R2_MOUNT_ACCESS,
    ...(options.s3fsOptions ? { s3fsOptions: options.s3fsOptions } : {}),
  }
  if (!options.prefix.trim()) throw new Error("A workspace mount requires a nonempty bucket prefix")
  return {
    directory: options.directory, access: request.access,
    connected: async signal => {
      const state = await mounts.inspect(options.directory, { signal })
      if (state.attachment.status !== "managed" || !("fuse" in state) || state.fuse.status !== "connected" || state.gateway.status !== "reachable" || state.gateway.upstream.status !== "usable") return false
      const config = state.attachment.configuration
      const requestedOptions = Object.entries(request.s3fsOptions ?? {}).filter(([, value]) => value !== false)
      return config.source.type === request.source.type
        && config.source.endpoint === new URL(request.source.endpoint).toString()
        && config.source.region === request.source.region
        && config.source.bucket === request.source.bucket
        && config.keyPrefix === `${options.prefix.replace(/\/+$/, "")}/`
        && config.access === request.access
        && config.s3fsOptions.length === requestedOptions.length
        && requestedOptions.every(([name, value]) => config.s3fsOptions.some(option => option.name === name && option.value === (value === true ? undefined : String(value))))
    },
    mount: signal => mounts.mount(request, { signal }),
    flush: options.flush,
    unmount: signal => mounts.unmount(options.directory, { signal }),
  }
}

// workspaceObjectName encodes actor, instance, and thread without delimiter collisions.
export const workspaceObjectName = (coordinate: { readonly actor: string; readonly instance: string; readonly thread: string }): string => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])

export interface WorkspaceObjectOptions<Env extends object> extends Omit<WorkspaceReadOptions, "contentStore"> {
  readonly contentStore?: (ctx: DurableObjectState, env: Env) => Layer.Layer<ObjectStorage, Error>
  // network requires entrypoint-managed HTTPS trust in allowlist mode (https://developers.cloudflare.com/containers/configuration/outbound-traffic/#trust-the-ca-certificate).
  readonly network?: WorkspaceNetworkPolicy
  readonly inactivityTimeoutMs?: number
  readonly idempotency?: boolean
  readonly directory: string
  readonly start: (env: Env, container: Container) => ContainerStartupOptions
  readonly mount?: (container: Container, ctx: DurableObjectState, env: Env) => WorkspaceMount
  readonly mounts?: (container: Container, ctx: DurableObjectState, env: Env) => readonly WorkspaceMount[]
  readonly policy?: Partial<ContainerWorkspacePolicy>
  readonly release?: WorkspaceRelease
}

// createWorkspaceObject exposes one container-backed filesystem through Durable Object RPC on Cloudflare or Celld.
export function createWorkspaceObject<Env extends object = Record<string, unknown>>(options: WorkspaceObjectOptions<Env>) {
  return workspaceObject<Env>((ctx, env) => {
    const container = ctx.container
    if (!container) throw new Error("WorkspaceObject requires a configured container")
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_WORKSPACE_INACTIVITY_TIMEOUT_MS
    if (!Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs < 1) throw new WorkspaceError("inactivityTimeoutMs must be a positive safe integer")
    if (container.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityTimeoutMs))
    const network = workspaceNetworkPolicy(options.network)
    const routes = workspaceNetworkRoutes(container, ctx, network)
    const start = async () => {
      const startup = options.start(env, container)
      const enableInternet = network.mode === "all"
      if (startup.enableInternet !== undefined && startup.enableInternet !== enableInternet) throw new WorkspaceError("Container startup enableInternet conflicts with the workspace network policy")
      await routes.install()
      container.start({ ...startup, enableInternet })
      await container.setInactivityTimeout(inactivityTimeoutMs)
    }
    const config = { container, files: new Files(container), directory: options.directory, start, ...(options.policy ? { policy: options.policy } : {}), ...(options.release ? { release: options.release } : {}) }
    const configured = (contentStore?: typeof ObjectStorage.Service) => Layer.unwrap(Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => ctx.storage.transaction(async storage => {
        const retained = await storage.get<WorkspaceNetworkPolicy>("tardie/workspace/network")
        if (retained !== undefined) {
          const saved = workspaceNetworkPolicy(retained)
          if (JSON.stringify(saved) !== JSON.stringify(network)) throw new WorkspaceError(`Workspace network policy is fixed at creation: stored ${JSON.stringify(saved)}, requested ${JSON.stringify(network)}`)
          return
        }
        if (container.running) throw new WorkspaceError("A running container without a stored workspace network policy must be stopped before a network policy can be established")
        await storage.put("tardie/workspace/network", network)
      }), catch: WorkspaceError.from })
      yield* Effect.tryPromise({ try: routes.install, catch: WorkspaceError.from })
      const store = options.idempotency ? yield* sqlIdempotencyStore : undefined
      const { idempotency: _idempotency, contentStore: _contentStore, mount: _mount, mounts: _mounts, ...readOptions } = options
      const mounts = [...(options.mounts?.(container, ctx, env) ?? []), ...(options.mount ? [options.mount(container, ctx, env)] : [])]
      return containerWorkspace({ ...readOptions, ...config, mounts, ...(store ? { idempotency: { workspaceId: ctx.id.toString(), store } } : {}), ...(contentStore ? { contentStore } : {}) })
    })).pipe(Layer.provide(SqliteClient.layer({ storage: ctx.storage })))
    return options.contentStore
      ? Layer.unwrap(Effect.map(ObjectStorage, store => configured(store))).pipe(Layer.provide(options.contentStore(ctx, env)))
      : configured()
  })
}
