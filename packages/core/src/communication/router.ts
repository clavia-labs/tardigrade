import { Context, Effect } from "effect"
import type { Event } from "../event"
import type { ActorAddress, ProviderAddress } from "./address"
import type { Delivery } from "./delivery"
import type { Link } from "./link"
import type { ThreadLineage } from "../thread"
import type { Transport, TransportDelivery } from "./transport"

// CallResult is a turn's boundary: a terminal or a park on a budget request.
export interface CallResult {
  readonly output?: string
  readonly error?: string
  readonly requesting?: boolean
  readonly reason?: string
  readonly amount?: number
  readonly callId?: string
}

// TransportRoute resolves one delivery to a named transport invocation.
export interface TransportRoute {
  readonly transport: string
  readonly invocationFor: (delivery: TransportDelivery) => (() => Effect.Effect<void>) | undefined
}

// transportRoute binds a coordinate resolver to one transport while keeping its coordinate type inside that route.
export const transportRoute = <Coordinates>(
  transport: Transport<Coordinates>,
  coordinatesFor: (delivery: TransportDelivery) => Coordinates | undefined
): TransportRoute => ({
  transport: transport.name,
  invocationFor: (delivery) => {
    const coordinates = coordinatesFor(delivery)
    return coordinates === undefined ? undefined : () => transport.deliver(coordinates, delivery)
  }
})

// deliverThrough resolves through exactly one transport. Missing and overlapping routes die before delivery begins (router.test.ts, "a missing route refuses the delivery" and "overlapping routes refuse before either transport sends").
export const deliverThrough = (
  routes: ReadonlyArray<TransportRoute>,
  delivery: TransportDelivery
): Effect.Effect<void> => {
  const matches = routes.flatMap((route) => {
    const invoke = route.invocationFor(delivery)
    return invoke === undefined ? [] : [{ transport: route.transport, invoke }]
  })
  if (matches.length === 0) {
    return Effect.die(new Error(`no transport accepts target ${JSON.stringify(delivery.link.target)}`))
  }
  if (matches.length > 1) {
    return Effect.die(new Error(`multiple transports accept target ${JSON.stringify(delivery.link.target)}: ${matches.map((match) => match.transport).join(", ")}`))
  }
  return matches[0]!.invoke()
}

// Router interprets typed links and selects the transport configured by its host.
export class Router extends Context.Service<
  Router,
  {
    readonly deliver: (
      delivery:
        | Delivery<ActorAddress, Event, ActorAddress>
        | Delivery<ActorAddress, Event, ProviderAddress>
    ) => Effect.Effect<void>
    readonly call: (
      link: Link<ActorAddress, ActorAddress>,
      message: {
        readonly id: string
        readonly text: string
        readonly output?: unknown
        readonly model?: string
        readonly budget?: number
        readonly escalatable?: boolean
        readonly actor?: string
        readonly shadow?: boolean
        readonly world?: string
        readonly lineage: ThreadLineage
      }
    ) => Effect.Effect<CallResult>
    readonly resume: (
      link: Link<ActorAddress, ActorAddress>,
      turn: string,
      decision: { readonly amount: number; readonly reason?: string }
    ) => Effect.Effect<CallResult>
  }
>()("tardigrade/Router") {}
