import { Schema } from "effect"

// ActorAddress names one durable thread under one deployed actor.
export const ActorAddress = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String
}).annotate({ identifier: "ActorAddress" })

export type ActorAddress = typeof ActorAddress.Type

// isActorAddress reports whether an unknown endpoint names an actor thread.
export const isActorAddress = (address: unknown): address is ActorAddress =>
  typeof address === "object" &&
  address !== null &&
  "actor" in address &&
  typeof address.actor === "string" &&
  "thread" in address &&
  typeof address.thread === "string"

// ProviderAddress names the configured provider instance that can interpret the remaining source coordinates.
export interface ProviderAddress {
  readonly provider: string
  readonly [coordinate: string]: unknown
}

// isProviderAddress reports whether an unknown source names an outbound provider instance.
export const isProviderAddress = (source: unknown): source is ProviderAddress =>
  typeof source === "object" &&
  source !== null &&
  "provider" in source &&
  typeof source.provider === "string"

// actorAddressOf constructs an actor address without applying placement.
export const actorAddressOf = (actor: string, thread: string): ActorAddress => ({ actor, thread })

// formatActorAddress preserves the existing actor:thread wire form while addresses become typed values.
export const formatActorAddress = (address: ActorAddress): string => `${address.actor}:${address.thread}`

// parseActorAddress reads the first segment as actor and defaults an absent thread to main.
export const parseActorAddress = (address: string): ActorAddress => {
  const separator = address.indexOf(":")
  return separator === -1
    ? { actor: address, thread: "main" }
    : { actor: address.slice(0, separator), thread: address.slice(separator + 1) }
}

// address preserves the legacy actor:thread encoder while callers migrate to ActorAddress.
export const address = (home: string, facet: string): string =>
  formatActorAddress(actorAddressOf(home, facet))

// readAddress preserves the legacy home and facet field names at compatibility call sites.
export const readAddress = (address: string): { readonly home: string; readonly facet: string } => {
  const parsed = parseActorAddress(address)
  return { home: parsed.actor, facet: parsed.thread }
}
