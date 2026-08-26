import type { Event as CoreEvent } from "../log/event"
import type { ThreadLineage } from "../thread"
import type { ActorId, Endpoint, ProviderEndpoint } from "./endpoint"
import type { Link } from "./link"
import type { MessageReceived } from "./message"
import type { ActorMethodInvocation } from "../actor/method/call"

// Envelope carries one event through a logical link without interpreting placement or transport.
export interface Envelope<Source = unknown, Event = MessageReceived, Target = ActorId> {
  readonly link: Link<Source, Target>
  readonly event: Event
  readonly call?: ActorMethodInvocation
  readonly lineage?: ThreadLineage
}

// ActorEnvelope carries any endpoint event to an actor identity.
export type ActorEnvelope<Event = CoreEvent> = Envelope<Endpoint, Event, ActorId>

// ProviderEnvelope carries one actor message to an external provider endpoint.
export type ProviderEnvelope = Envelope<ActorId, MessageReceived, ProviderEndpoint>

// RoutedEnvelope is the complete envelope family Router can send.
export type RoutedEnvelope = ActorEnvelope | ProviderEnvelope

// isActorEnvelope reports whether an envelope targets an actor identity.
export const isActorEnvelope = (envelope: RoutedEnvelope): envelope is ActorEnvelope =>
  "actor" in envelope.link.target && typeof envelope.link.target.actor === "string"

// isProviderEnvelope reports whether an envelope targets a provider and carries its message protocol.
export const isProviderEnvelope = (envelope: RoutedEnvelope): envelope is ProviderEnvelope =>
  "provider" in envelope.link.target &&
  typeof envelope.link.target.provider === "string" &&
  envelope.event.type === "MessageReceived"

// LinkedEvent preserves the accepted link beside its event in the target actor's durable log.
export type LinkedEvent<Source = unknown, Event = MessageReceived> = Event & {
  readonly link: Link<Source, ActorId>
  readonly call?: ActorMethodInvocation
}

// envelopeOf constructs one envelope without interpreting either endpoint.
export const envelopeOf = <Source, Target, Event>(
  link: Link<Source, Target>,
  event: Event,
  lineage?: ThreadLineage
): Envelope<Source, Event, Target> => ({ link, event, ...(lineage === undefined ? {} : { lineage }) })

// methodEnvelopeOf carries the declared method identity independently of its domain event.
export const methodEnvelopeOf = <Source, Target, Event>(
  link: Link<Source, Target>,
  call: ActorMethodInvocation,
  event: Event,
  lineage?: ThreadLineage
): Envelope<Source, Event, Target> => ({
  link,
  call,
  event,
  ...(lineage === undefined ? {} : { lineage })
})

// linkedEventOf attaches an accepted envelope's link to the event committed at its actor target.
export const linkedEventOf = <Source, Event extends object>(
  envelope: Envelope<Source, Event, ActorId>
): LinkedEvent<Source, Event> => ({
  ...envelope.event,
  link: envelope.link,
  ...(envelope.call === undefined ? {} : { call: envelope.call })
})
