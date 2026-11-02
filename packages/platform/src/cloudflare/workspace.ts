import { Files, S3Mount, type S3GatewayBinding, type S3MountRequest } from "@cloudflare/sandbox"
import { workspaceObject } from "./workspace-object"
import { containerWorkspace, type ContainerWorkspacePolicy, type WorkspaceMount, type WorkspaceRelease } from "../shared/workspace/container"
import { mountedWorkspace } from "../shared/workspace/mounted"
export { S3Gateway } from "@cloudflare/sandbox"
export { containerWorkspace, DEFAULT_CONTAINER_WORKSPACE_POLICY, DEFAULT_WORKSPACE_RELEASE, type ContainerWorkspaceOptions, type ContainerWorkspacePolicy, type WorkspaceMount, type WorkspaceRelease } from "../shared/workspace/container"
export { mountedWorkspace } from "../shared/workspace/mounted"
export { remoteWorkspace, type RemoteWorkspace } from "../shared/workspace/remote"

export interface R2MountOptions {
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
  return { directory: options.directory, access: request.access, mount: signal => mounts.mount(request, { signal }), unmount: signal => mounts.unmount(options.directory, { signal }) }
}

// workspaceObjectName encodes actor, instance, and thread without delimiter collisions.
export const workspaceObjectName = (coordinate: { readonly actor: string; readonly instance: string; readonly thread: string }): string => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])

export interface WorkspaceObjectOptions<Env extends object> {
  readonly directory: string
  readonly start: (env: Env, container: Container) => ContainerStartupOptions
  readonly mount?: (container: Container, ctx: DurableObjectState, env: Env) => WorkspaceMount
  readonly policy?: Partial<ContainerWorkspacePolicy>
  readonly release?: WorkspaceRelease
}

// createWorkspaceObject exposes one container-backed filesystem through Durable Object RPC on Cloudflare or Celld.
export function createWorkspaceObject<Env extends object = Record<string, unknown>>(options: WorkspaceObjectOptions<Env>) {
  return workspaceObject<Env>((ctx, env) => {
    const container = ctx.container
    if (!container) throw new Error("WorkspaceObject requires a configured container")
    const config = { container, files: new Files(container), directory: options.directory, start: () => container.start(options.start(env, container)), ...(options.policy ? { policy: options.policy } : {}), ...(options.release ? { release: options.release } : {}) }
    return options.mount ? mountedWorkspace({ ...config, mount: options.mount(container, ctx, env) }) : containerWorkspace(config)
  })
}
