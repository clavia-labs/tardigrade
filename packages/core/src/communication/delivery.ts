import type { MessageReceived } from "./message"
import type { ActorAddress } from "./address"
import type { Link } from "./link"

// Delivery carries one canonical inbound through a link whose target is an actor thread (tla/Link.tla, NoMisroute).
export interface Delivery<Source = unknown, Event = MessageReceived> {
  readonly link: Link<Source, ActorAddress>
  readonly event: Event
}

// LinkedEvent preserves the accepted link beside its event in the target actor's durable log.
export type LinkedEvent<Source = unknown, Event = MessageReceived> = Event & {
  readonly link: Link<Source, ActorAddress>
}

// deliveryOf constructs one delivery without interpreting its source address.
export const deliveryOf = <Source, Event>(
  link: Link<Source, ActorAddress>,
  event: Event
): Delivery<Source, Event> => ({ link, event })

// linkedEventOf attaches a delivery's routing evidence to the event committed at its target.
export const linkedEventOf = <Source, Event extends object>(
  delivery: Delivery<Source, Event>
): LinkedEvent<Source, Event> => ({ ...delivery.event, link: delivery.link })
