import type { ActorDO } from "@clavia/tardigrade-cloudflare/actor"
import type { ThreadDO } from "@clavia/tardigrade-cloudflare/thread"
import * as Cloudflare from "alchemy/Cloudflare"

import {
  ACTORS_BINDING,
  THREADS_BINDING,
  tardigradeClassNames,
  type TardigradeBindingsOptions,
} from "./names"

export {
  ACTOR_CLASS,
  ACTORS_BINDING,
  THREAD_CLASS,
  THREADS_BINDING,
  tardigradeClassNames,
  type TardigradeBindingsOptions,
} from "./names"

/**
 * tardigradeBindings declares both host namespaces as alchemy Worker bindings.
 *
 * Pass the result under the worker's `bindings` prop. The host resolves its objects through `env.ACTORS` and `env.THREADS`, so the binding names are fixed and only the exported class names are overridable.
 */
export const tardigradeBindings = (options: TardigradeBindingsOptions = {}) => {
  const names = tardigradeClassNames(options)
  return {
    ACTORS: Cloudflare.DurableObject<ActorDO>(ACTORS_BINDING, {
      className: names.actorClassName,
    }),
    THREADS: Cloudflare.DurableObject<ThreadDO>(THREADS_BINDING, {
      className: names.threadClassName,
    }),
  }
}
