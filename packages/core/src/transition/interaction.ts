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

// InteractionScope supplies pure input constructors to a component subtree (tla/component/SuppliedInteraction.tla, ReceiverIsPreserved).
export interface InteractionScope {
  readonly name: string
  readonly define: <Input>(events: (input: Input, origin: InteractionOrigin) => Event | ReadonlyArray<Event>) => (input: Input) => InteractionRequest
}

const requests = new WeakMap<InteractionRequest, {
  readonly scope: InteractionScope
  readonly events: (origin: InteractionOrigin) => Event | ReadonlyArray<Event>
}>()

// interactionScope creates capabilities whose requests can be bound only inside a component supplying that scope.
export const interactionScope = (name: string): InteractionScope => {
  if (name.length === 0) throw new Error("interaction scope requires a name")
  const scope: InteractionScope = Object.freeze({
    name,
    define: <Input>(events: (input: Input, origin: InteractionOrigin) => Event | ReadonlyArray<Event>) =>
      (input: Input): InteractionRequest => {
        const request: InteractionRequest = Object.freeze({ [requestBrand]: true as const })
        requests.set(request, { scope, events: (origin) => events(input, origin) })
        return request
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
  if (!scopes.has(declared.scope)) throw new Error(`interaction scope ${JSON.stringify(declared.scope.name)} is not supplied by this component's ancestors`)
  return (at) => declared.events({ id, at })
}
