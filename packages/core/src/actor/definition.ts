import type { Actor as ReconciledActor } from "../reconciliation"
import { actorFromReactors, type Self } from "../reconciliation"
import {
  reactorOf,
  type Component,
  type ComponentRequirements
} from "./component"
import { composeKeys } from "../log"
import type { Router } from "../communication/router"
import {
  actorMethodsOf,
  methodResponseComponent,
  methodResponseKeys,
  type ActorMethods
} from "./method/index"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

// Actor binds an identity and callable surface to the components reconciled over each private log.
export interface Actor<R = never, Methods extends ActorMethods = ActorMethods> extends ReconciledActor<R> {
  readonly name: string
  readonly methods: Methods
  readonly components: ReadonlyArray<Component<unknown, unknown>>
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
> = Actor<ComponentRequirements<Components[number]> | Router | Self, Methods>

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
  const fragments = components.flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const responses = methodResponseComponent(methods)
  const runtime = actorFromReactors<R>(
    [...components.map(reactorOf), reactorOf(responses)],
    composeKeys(...fragments, methodResponseKeys)
  )
  return {
    ...runtime,
    name: options.name,
    methods,
    components: options.components as ReadonlyArray<Component<unknown, unknown>>
  }
}

// actor constructs a named actor from methods and components.
export const actor = <
  const Methods extends ActorMethods,
  const Components extends ReadonlyArray<Component<unknown, never> | Component<unknown, unknown>>
>(options: ActorOptions<Methods, Components>): ActorOf<Methods, Components> => fromOptions(options)
