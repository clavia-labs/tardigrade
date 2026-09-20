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
 * The object keys are the env names the host reads; the factory argument is the class name the worker entry exports, per alchemy's DurableObject binding.
 */
export const tardigradeBindings = (options: TardigradeBindingsOptions = {}) => {
  const names = tardigradeClassNames(options)
  return {
    ACTORS: Cloudflare.DurableObject<ActorDO>(names.actorClassName),
    THREADS: Cloudflare.DurableObject<ThreadDO>(names.threadClassName),
  }
}
