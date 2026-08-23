import type { MessageReceived } from "./message"
import type { ActorAddress } from "./address"
import type { Link } from "./link"
import type { ThreadLineage } from "../thread"

// Delivery carries one canonical inbound through a link whose target is an actor thread (tla/communication/Link.tla, NoMisroute).
export interface Delivery<Source = unknown, Event = MessageReceived, Target = ActorAddress> {
  readonly link: Link<Source, Target>
  readonly event: Event
  readonly lineage?: ThreadLineage
}

// LinkedEvent preserves the accepted link beside its event in the target actor's durable log.
export type LinkedEvent<Source = unknown, Event = MessageReceived> = Event & {
  readonly link: Link<Source, ActorAddress>
}

// deliveryOf constructs one delivery without interpreting its source address.
export const deliveryOf = <Source, Target, Event>(
  link: Link<Source, Target>,
  event: Event,
  lineage?: ThreadLineage
): Delivery<Source, Event, Target> => ({ link, event, ...(lineage === undefined ? {} : { lineage }) })

// linkedEventOf attaches a delivery's routing evidence to the event committed at its target.
export const linkedEventOf = <Source, Event extends object>(
  delivery: Delivery<Source, Event>
): LinkedEvent<Source, Event> => ({ ...delivery.event, link: delivery.link })
