import { Schema } from "effect"

// ThreadAddress identifies one durable thread under one actor definition independently of its activation and placement.
export const ThreadAddress = Schema.Struct({
  actor: Schema.String,
  thread: Schema.String
}).annotate({ identifier: "ThreadAddress" })

export type ThreadAddress = typeof ThreadAddress.Type

// isThreadAddress reports whether an unknown endpoint identifies an actor thread.
export const isThreadAddress = (endpoint: unknown): endpoint is ThreadAddress =>
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
export type Endpoint = ThreadAddress | ProviderEndpoint

// threadAddressOf constructs one thread address without applying placement.
export const threadAddressOf = (actor: string, thread: string): ThreadAddress => ({ actor, thread })

// formatThreadAddress encodes a thread address in the actor:thread wire form.
export const formatThreadAddress = (id: ThreadAddress): string => `${id.actor}:${id.thread}`

// parseThreadAddress decodes the first segment as actor and defaults an absent thread to main.
export const parseThreadAddress = (value: string): ThreadAddress => {
  const separator = value.indexOf(":")
  return separator === -1
    ? { actor: value, thread: "main" }
    : { actor: value.slice(0, separator), thread: value.slice(separator + 1) }
}
