import type { Actor as ReconciledActor } from "../reconciliation"
import type { Event } from "../log/event"
import { actorFromReactors, type Self } from "../reconciliation"
import {
  reactorOf,
  type Component,
  type ComponentRequirements
} from "./component"
import { composeKeys } from "../log"
import type { Router } from "../communication/router"
import { actorContractErrors, actorContractOf, type ActorContract } from "./contract"
import {
  actorMethodsOf,
  methodCallKeys,
  methodResponseComponent,
  methodResponseKeys,
  methodInputValidationComponents,
  methodInputValidationTransitions,
  methodTimeoutComponent,
  methodTimeoutKeys,
  type ActorMethods
} from "./method/index"
import type { ActorInvocation } from "./method"
import {
  CANCELLATION_CONTROL_METHOD,
  cancellationKeys,
  cancellationMethodFor,
  cancellationTransitionsOf
} from "./method/cancellation"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

// Actor binds an identity and callable surface to the components reconciled over each private log.
export interface Actor<R = never, Methods extends ActorMethods = ActorMethods> extends ReconciledActor<R> {
  readonly name: string
  readonly methods: Methods
  readonly components: ReadonlyArray<Component<unknown, unknown>>
  readonly contract?: ActorContract
}

// ActorOptions declares the complete public and private shape of an actor.
export interface ActorOptions<
  Methods extends ActorMethods,
  Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
> {
  readonly name: string
  readonly methods: Methods
  readonly components: Components
}

type ActorOf<
  Methods extends ActorMethods,
  Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
> = Actor<ComponentRequirements<Components[number]> | Router | Self, Methods> & { readonly contract: ActorContract }

const fromOptions = <
  const Methods extends ActorMethods,
  const Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(options: ActorOptions<Methods, Components>): ActorOf<Methods, Components> => {
  if (!ACTOR_NAME_PATTERN.test(options.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(options.name)}`)
  }
  const methods = actorMethodsOf(options.methods)
  type R = ComponentRequirements<Components[number]> | Router | Self
  const components = options.components as ReadonlyArray<Component<unknown, R>>
  const inputValidation = methodInputValidationComponents(methods)
  const fragments = [...inputValidation, ...components].flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const responses = methodResponseComponent({
    ...methods,
    [CANCELLATION_CONTROL_METHOD]: cancellationMethodFor(methods)
  })
  const contract = actorContractOf(methods, options.components as ReadonlyArray<Component<unknown, unknown>>)
  const keyOf = composeKeys(...fragments, cancellationKeys, methodCallKeys, methodTimeoutKeys, methodResponseKeys)
  const cancellationOf = (events: ReadonlyArray<Event>, invocation: ActorInvocation) =>
    methods[invocation.method]?.cancellation?.state(events, invocation)
  const cancellationResiduals = (events: ReadonlyArray<Event>) =>
    cancellationTransitionsOf(events, methods, components, keyOf)
  const guarded = components.map((component) => {
    const derive = reactorOf(component)
    return (log: Parameters<typeof derive>[0]) => {
      const recorded = new Set(log.flatMap((event) => {
        const key = keyOf(event)
        return key === undefined ? [] : [key]
      }))
      const invalid = methodInputValidationTransitions(methods, log).some((transition) => !recorded.has(transition.key))
      return invalid ? [] : derive(log)
    }
  })
  const runtime = actorFromReactors<R>(
    [...guarded, ...inputValidation.map(reactorOf), reactorOf(methodTimeoutComponent(methods)), reactorOf(responses)],
    keyOf,
    cancellationOf,
    cancellationResiduals
  )
  return {
    ...runtime,
    name: options.name,
    methods,
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
