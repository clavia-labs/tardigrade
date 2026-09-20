/**
 * ACTORS_BINDING names the supervisor namespace that the host resolves through `env.ACTORS` (platform/cloudflare/src/actor.ts).
 */
export const ACTORS_BINDING = "ACTORS"

/**
 * THREADS_BINDING names the thread namespace that the host resolves through `env.THREADS` (platform/cloudflare/src/thread.ts).
 */
export const THREADS_BINDING = "THREADS"

/**
 * ACTOR_CLASS is the class name the worker entry must export for the supervisor namespace.
 */
export const ACTOR_CLASS = "ActorDO"

/**
 * THREAD_CLASS is the class name the worker entry must export for the thread namespace.
 */
export const THREAD_CLASS = "ThreadDO"

export interface TardigradeBindingsOptions {
  readonly actorClassName?: string
  readonly threadClassName?: string
}

export interface TardigradeClassNames {
  readonly actorClassName: string
  readonly threadClassName: string
}

/**
 * tardigradeClassNames resolves the exported class names a worker entry provides.
 *
 * The binding names are the contract the host reads, so only the class names resolve here.
 */
export const tardigradeClassNames = (
  options: TardigradeBindingsOptions = {},
): TardigradeClassNames => ({
  actorClassName: options.actorClassName ?? ACTOR_CLASS,
  threadClassName: options.threadClassName ?? THREAD_CLASS,
})
