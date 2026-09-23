import { Context } from "effect"
import type { Event } from "../event"

const requestBrand: unique symbol = Symbol("interaction.request")

// InteractionRequest describes input whose source identity is supplied when a component offers it (component/composition/supplied-interaction.properties.test.ts).
export interface InteractionRequest {
  readonly [requestBrand]: true
}

export interface InteractionOrigin {
  readonly id: string
  readonly at: number
}

// InteractionScope groups stable input constructors under a binding identity (tla/component/SuppliedInteraction.tla, ReceiverIsPreserved).
export interface InteractionScope {
  readonly name: string
  readonly define: <Input>(events: (input: Input, origin: InteractionOrigin) => Event | ReadonlyArray<Event>) => (input: Input) => InteractionRequest
}

// ComponentInputs names stable request constructors exposed independently of component output.
export type ComponentInputs = Readonly<Record<string, (input: never) => InteractionRequest>>

const constructors = new WeakMap<object, InteractionScope>()

// inputScopesOf resolves the scopes declared by a component's public inputs.
export const inputScopesOf = (input: ComponentInputs | undefined): ReadonlySet<InteractionScope> => {
  const scopes = new Set<InteractionScope>()
  for (const constructor of Object.values(input ?? {})) {
    const scope = constructors.get(constructor)
    if (scope === undefined) throw new Error("component input requires an interaction constructor")
    scopes.add(scope)
  }
  return scopes
}

const requests = new WeakMap<InteractionRequest, {
  readonly scope: InteractionScope
  readonly events: (origin: InteractionOrigin) => Event | ReadonlyArray<Event>
}>()

// interactionScope defines stable inputs authorized through component declarations (component/composition/supplied-interaction.properties.test.ts).
export const interactionScope = (name: string): InteractionScope => {
  if (name.length === 0) throw new Error("interaction scope requires a name")
  const scope: InteractionScope = Object.freeze({
    name,
    define: <Input>(events: (input: Input, origin: InteractionOrigin) => Event | ReadonlyArray<Event>) => {
      const constructor = (input: Input): InteractionRequest => {
        const request: InteractionRequest = Object.freeze({ [requestBrand]: true as const })
        requests.set(request, { scope, events: (origin) => events(input, origin) })
        return request
      }
      constructors.set(constructor, scope)
      return constructor
    }
  })
  return scope
}

// SuppliedInteractions carries lexical capability scopes through component initialization.
export class SuppliedInteractions extends Context.Service<SuppliedInteractions, ReadonlySet<InteractionScope>>()("tardigrade/SuppliedInteractions") {}

// interactionEvents binds a request to its source identity without executing its event constructor.
export const interactionEvents = (request: InteractionRequest, scopes: ReadonlySet<InteractionScope>, id: string): ((at: number) => Event | ReadonlyArray<Event>) => {
  const declared = requests.get(request)
  if (declared === undefined) throw new Error("unknown interaction request")
  if (!scopes.has(declared.scope)) throw new Error(`interaction scope ${JSON.stringify(declared.scope.name)} is not supplied by this component's input, ancestors, or children`)
  return (at) => declared.events({ id, at })
}
