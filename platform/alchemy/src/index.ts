import * as Cloudflare from "alchemy/Cloudflare"

import { tardigradeBindingsWith } from "./bindings"
import type { TardigradeBindingsOptions } from "./names"

export { tardigradeBindingsWith, type DurableObjectBinding, type DurableObjectFactory } from "./bindings"
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
 * The object keys are the env names the host reads. The factory argument is the class name the worker entry exports, which is what alchemy binds.
 */
export const tardigradeBindings = (options: TardigradeBindingsOptions = {}) =>
  tardigradeBindingsWith(Cloudflare, options)
