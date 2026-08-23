import { Schema } from "effect"

// ActorId identifies one durable thread under one deployed actor independently of its activation and location.
export const ActorId = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String
}).annotate({ identifier: "ActorId" })

export type ActorId = typeof ActorId.Type

// isActorId reports whether an unknown endpoint identifies an actor thread.
export const isActorId = (endpoint: unknown): endpoint is ActorId =>
  typeof endpoint === "object" &&
  endpoint !== null &&
  "actor" in endpoint &&
  typeof endpoint.actor === "string" &&
  "thread" in endpoint &&
  typeof endpoint.thread === "string"

// ProviderEndpoint identifies one external provider instance and the coordinates it interprets.
export interface ProviderEndpoint {
  readonly provider: string
  readonly [coordinate: string]: unknown
}

// isProviderEndpoint reports whether an unknown endpoint identifies an external provider instance.
export const isProviderEndpoint = (endpoint: unknown): endpoint is ProviderEndpoint =>
  typeof endpoint === "object" &&
  endpoint !== null &&
  "provider" in endpoint &&
  typeof endpoint.provider === "string"

// Endpoint identifies a logical communication endpoint without describing its physical location.
export type Endpoint = ActorId | ProviderEndpoint

// actorIdOf constructs one actor identity without applying placement.
export const actorIdOf = (actor: string, thread: string): ActorId => ({ actor, thread })

// formatActorId encodes an actor identity in the actor:thread wire form.
export const formatActorId = (id: ActorId): string => `${id.actor}:${id.thread}`

// parseActorId decodes the first segment as actor and defaults an absent thread to main.
export const parseActorId = (value: string): ActorId => {
  const separator = value.indexOf(":")
  return separator === -1
    ? { actor: value, thread: "main" }
    : { actor: value.slice(0, separator), thread: value.slice(separator + 1) }
}
