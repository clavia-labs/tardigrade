import type { Effect } from "effect"
import type { Event } from "../event"
import type { ActorAddress, ProviderAddress } from "./address"
import type { Delivery } from "./delivery"

// TransportDelivery is the routed envelope a physical delivery path carries.
export type TransportDelivery =
  | Delivery<ActorAddress, Event, ActorAddress>
  | Delivery<ActorAddress, Event, ProviderAddress>

// Transport carries deliveries over one named path using coordinates resolved by Router.
export interface Transport<Coordinates> {
  readonly name: string
  readonly deliver: (coordinates: Coordinates, delivery: TransportDelivery) => Effect.Effect<void>
}
