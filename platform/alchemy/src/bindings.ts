import type { ActorDO } from "@clavia/tardigrade-cloudflare/actor"
import type { ThreadDO } from "@clavia/tardigrade-cloudflare/thread"

import { tardigradeClassNames, type TardigradeBindingsOptions } from "./names"

/**
 * DurableObjectBinding is the part of an alchemy Durable Object binding the namespaces rely on.
 */
export interface DurableObjectBinding<Shape> {
  readonly kind: string
  readonly name: string
  readonly className?: string
  readonly Shape?: Shape
}

/**
 * DurableObjectFactory is the part of alchemy these bindings call.
 *
 * Typing it structurally keeps this module free of a runtime alchemy import, so the contract stays testable without loading the framework.
 */
export interface DurableObjectFactory {
  readonly DurableObject: <Shape>(name: string) => DurableObjectBinding<Shape>
}

/**
 * tardigradeBindingsWith declares both host namespaces using the supplied alchemy module.
 *
 * The object keys are the env names the host reads. The factory argument is the class name the worker entry exports, which is what alchemy binds.
 */
export const tardigradeBindingsWith = (
  cloudflare: DurableObjectFactory,
  options: TardigradeBindingsOptions = {},
): { ACTORS: DurableObjectBinding<ActorDO>; THREADS: DurableObjectBinding<ThreadDO> } => {
  const names = tardigradeClassNames(options)
  return {
    ACTORS: cloudflare.DurableObject<ActorDO>(names.actorClassName),
    THREADS: cloudflare.DurableObject<ThreadDO>(names.threadClassName),
  }
}
