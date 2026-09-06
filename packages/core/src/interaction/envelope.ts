import type { Event as CoreEvent } from "../event"
import type { Envelope as TransportEnvelope } from "../transport/envelope"
import type { ThreadAddress, Endpoint, ProviderEndpoint } from "../transport/endpoint"
import type { MessageReceived } from "./provider-message"
import type { Link } from "../transport/link"
import type { ThreadLineage } from "./relations"
import { decodeActorInvocationContext, type ActorInvocationContext } from "./invocation"

// Envelope carries one event through a logical link without interpreting placement or transport.
// TODO: Carry capability credentials separately from event data and exclude them from durable logs.
export interface Envelope<Source = unknown, Event = MessageReceived, Target = ThreadAddress, Call = unknown>
  extends TransportEnvelope<Source, Event, Target> {
  readonly call?: Call
  readonly lineage?: ThreadLineage
}

// ActorEnvelope carries any endpoint event to an actor identity.
export type ActorEnvelope<Event = CoreEvent> = Envelope<Endpoint, Event, ThreadAddress>

// ProviderEnvelope carries one actor message to an external provider endpoint.
export type ProviderEnvelope = Envelope<ThreadAddress, MessageReceived, ProviderEndpoint>

// RoutedEnvelope is the complete envelope family Router can send.
export type RoutedEnvelope = ActorEnvelope | ProviderEnvelope

// isActorEnvelope reports whether an envelope targets an actor identity.
export const isActorEnvelope = (envelope: TransportEnvelope): envelope is ActorEnvelope =>
  typeof envelope.link.target === "object" && envelope.link.target !== null &&
  "actor" in envelope.link.target && typeof envelope.link.target.actor === "string"

// isProviderEnvelope reports whether an envelope targets a provider and carries its message protocol.
export const isProviderEnvelope = (envelope: TransportEnvelope): envelope is ProviderEnvelope =>
  typeof envelope.link.target === "object" && envelope.link.target !== null &&
  "provider" in envelope.link.target &&
  typeof envelope.link.target.provider === "string" &&
  typeof envelope.event === "object" && envelope.event !== null &&
  "type" in envelope.event && envelope.event.type === "MessageReceived"

// LinkedEvent preserves the accepted link beside its event in the target actor's durable log.
export type LinkedEvent<Source = unknown, Event = MessageReceived> = Event & {
  readonly link: Link<Source, ThreadAddress>
  readonly call?: unknown
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
  call: ActorInvocationContext,
  event: Event,
  lineage?: ThreadLineage
): Envelope<Source, Event, Target, ActorInvocationContext> => ({
  link,
  call: decodeActorInvocationContext(call),
  event,
  ...(lineage === undefined ? {} : { lineage })
})

// invokedEventOf attaches the context required to identify one accepted method invocation.
export const invokedEventOf = <Event extends object>(
  call: ActorInvocationContext,
  event: Event
): Event & { readonly call: ActorInvocationContext } => ({ ...event, call: decodeActorInvocationContext(call) })

// linkedEventOf attaches an accepted envelope's link and validated invocation context.
export const linkedEventOf = <Source, Event extends object>(
  envelope: Envelope<Source, Event, ThreadAddress>
): LinkedEvent<Source, Event> => ({
  ...(envelope.call === undefined ? envelope.event : invokedEventOf(decodeActorInvocationContext(envelope.call), envelope.event)),
  link: envelope.link
})
