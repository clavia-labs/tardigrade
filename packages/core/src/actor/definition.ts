import { actorFromProjections, type Actor as ReconciledActor, type Self } from "@clavia/tardigrade-core/runtime/reconciler"
import {
  transitionProjectionOf,
  type Component,
  type ComponentRequirements
} from "@clavia/tardigrade-core/component"
import { composeKeys } from "../log"
import type { Router } from "../communication/router"
import { actorContractErrors, actorContractOf, type ActorContract } from "./contract"
import {
  actorMethodsOf,
  methodCallKeys,
  methodResponseKeys,
  methodInputValidationComponents,
  methodTimeoutKeys,
  type ActorMethods
} from "../method/index"
import {
  CANCELLATION_CONTROL_METHOD,
  childCancellationTimeoutOf,
  cancellationKeys,
  cancellationMethodFor
} from "../method/cancellation"
import { actorProjection } from "./projection"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

// Actor binds an identity and callable surface to the components reconciled over each private log.
export interface Actor<R = never, Methods extends ActorMethods = ActorMethods> extends ReconciledActor<R> {
  readonly name: string
  readonly methods: Methods
  readonly components: ReadonlyArray<Component<unknown, unknown>>
  readonly cancellation?: ActorCancellationPolicy
  readonly contract?: ActorContract
}

// ActorCancellationPolicy bounds cancellation coordination owned by the actor runtime.
export interface ActorCancellationPolicy {
  readonly childTimeoutMs: number
}

// ActorOptions declares the complete public and private shape of an actor.
export interface ActorOptions<
  Methods extends ActorMethods,
  Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
> {
  readonly name: string
  readonly methods: Methods
  readonly components: Components
  readonly cancellation?: Partial<ActorCancellationPolicy>
}

type ActorOf<
  Methods extends ActorMethods,
  Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
> = Actor<ComponentRequirements<Components[number]> | Router | Self, Methods> & {
  readonly cancellation: ActorCancellationPolicy
  readonly contract: ActorContract
}

const fromOptions = <
  const Methods extends ActorMethods,
  const Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(options: ActorOptions<Methods, Components>): ActorOf<Methods, Components> => {
  if (!ACTOR_NAME_PATTERN.test(options.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(options.name)}`)
  }
  const methods = actorMethodsOf(options.methods)
  const cancellation = {
    childTimeoutMs: childCancellationTimeoutOf(options.cancellation?.childTimeoutMs)
  }
  type R = ComponentRequirements<Components[number]> | Router | Self
  const components = options.components as ReadonlyArray<Component<unknown, R>>
  const inputValidation = methodInputValidationComponents(methods)
  const fragments = [...inputValidation, ...components].flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const responseMethods = {
    ...methods,
    [CANCELLATION_CONTROL_METHOD]: cancellationMethodFor(methods)
  }
  const contract = actorContractOf(methods, options.components as ReadonlyArray<Component<unknown, unknown>>)
  const keyOf = composeKeys(...fragments, cancellationKeys, methodCallKeys, methodTimeoutKeys, methodResponseKeys)
  const projection = actorProjection(methods, responseMethods, components, keyOf, cancellation.childTimeoutMs)
  const validationProjections = inputValidation.map(transitionProjectionOf)
  const runtime = actorFromProjections<R>({
    transitions: validationProjections,
    guards: validationProjections,
    control: projection,
    keyOf
  })
  return {
    ...runtime,
    name: options.name,
    methods,
    cancellation,
    contract,
    components: options.components as ReadonlyArray<Component<unknown, unknown>>
  }
}

// actor constructs a named actor from methods and components.
export const actor = <
  const Methods extends ActorMethods,
  const Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(options: ActorOptions<Methods, Components>): ActorOf<Methods, Components> => fromOptions(options)

// validateActor refuses an actor whose declared method surface and component seams disagree.
export const validateActor = <A extends Actor<unknown> & { readonly contract: ActorContract }>(definition: A): A => {
  const errors = actorContractErrors(definition.contract)
  if (errors.length > 0) {
    throw new Error(`actor ${JSON.stringify(definition.name)} has invalid method seams:\n${errors.map((error) => `- ${error}`).join("\n")}`)
  }
  return definition
}
