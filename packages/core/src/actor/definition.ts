import type { Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Component, ComponentRequirements } from "@clavia/tardigrade-core/component"
import type { Router } from "../transport/router"
import { actorContractErrors, actorContractOf, type ActorContract } from "./contract"
import { actorMethodsOf, type ActorMethods } from "./method"
import { childCancellationTimeoutOf } from "../interaction/cancellation"
import { allocateRootThread, allocateChildThread, type ActorAllocation } from "./allocation"
import type { InvocationScope } from "../interaction/execution"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

// ActorDefinition names the methods and components that describe an actor's behavior.
export interface ActorDefinition<Methods extends ActorMethods = ActorMethods> {
  readonly name: string
  readonly methods: Methods
  readonly components: ReadonlyArray<Component<unknown, unknown>>
}

// Actor describes behavior and the services required to execute it.
export interface Actor<R = never, Methods extends ActorMethods = ActorMethods> extends ActorDefinition<Methods> {
  readonly components: ReadonlyArray<Component<unknown, R>>
  readonly cancellation?: ActorCancellationPolicy
  readonly contract?: ActorContract
}

type ActorComponents = ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>

// ActorCancellationPolicy bounds cancellation coordination owned by the actor runtime.
export interface ActorCancellationPolicy {
  readonly childTimeoutMs: number
}

// ActorOptions declares the complete public and private shape of an actor.
export interface ActorOptions<
  Methods extends ActorMethods,
  Components extends ActorComponents
> {
  readonly name: string
  readonly methods: Methods
  readonly components: Components
  readonly cancellation?: Partial<ActorCancellationPolicy>
}

type ActorOf<
  Methods extends ActorMethods,
  Components extends ActorComponents
> = Actor<Exclude<ComponentRequirements<Components[number]>, InvocationScope> | Router | Self, Methods> & ActorAllocation<Methods> & {
  readonly cancellation: ActorCancellationPolicy
  readonly contract: ActorContract
}

// actor constructs a named actor from methods and components.
export const actor = <
  const Methods extends ActorMethods,
  const Components extends ActorComponents
>(options: ActorOptions<Methods, Components>): ActorOf<Methods, Components> => {
  if (!ACTOR_NAME_PATTERN.test(options.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(options.name)}`)
  }
  const methods = actorMethodsOf(options.methods)
  const cancellation = {
    childTimeoutMs: childCancellationTimeoutOf(options.cancellation?.childTimeoutMs)
  }
  type R = Exclude<ComponentRequirements<Components[number]>, InvocationScope> | Router | Self
  const components = options.components as ReadonlyArray<Component<unknown, R>>
  const definition = { name: options.name, methods, components }
  const contract = actorContractOf(methods, definition.components)
  return {
    ...definition,
    allocateRootThread: (request) => allocateRootThread(definition, request),
    allocateChildThread: (request) => allocateChildThread(definition, request),
    cancellation,
    contract
  }
}

// defineActor describes a named actor without constructing its runtime.
export const defineActor = <const Methods extends ActorMethods, const Components extends ActorComponents>(
  name: string,
  methods: Methods,
  components: Components,
  options: Pick<ActorOptions<Methods, Components>, "cancellation"> = {}
): ActorOf<Methods, Components> => actor({ name, methods, components, ...options })

// validateActor refuses an actor whose declared method surface and component seams disagree.
export const validateActor = <A extends ActorDefinition & { readonly contract: ActorContract }>(definition: A): A => {
  const errors = actorContractErrors(definition.contract)
  if (errors.length > 0) {
    throw new Error(`actor ${JSON.stringify(definition.name)} has invalid method seams:\n${errors.map((error) => `- ${error}`).join("\n")}`)
  }
  return definition
}
