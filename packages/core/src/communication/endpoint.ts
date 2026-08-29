import { Schema } from "effect"

// ThreadAddress identifies one durable thread under one actor instance independently of its activation and placement.
export const ThreadAddress = Schema.Struct({
  actor: Schema.String,
  instance: Schema.String,
  thread: Schema.String
}).annotate({ identifier: "ThreadAddress" })

export type ThreadAddress = typeof ThreadAddress.Type

// isThreadAddress reports whether an unknown endpoint identifies an actor thread.
export const isThreadAddress = (endpoint: unknown): endpoint is ThreadAddress =>
  typeof endpoint === "object" &&
  endpoint !== null &&
  "actor" in endpoint &&
  typeof endpoint.actor === "string" &&
  "instance" in endpoint &&
  typeof endpoint.instance === "string" &&
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
export const threadAddressOf = (actor: string, instance: string, thread: string): ThreadAddress => ({ actor, instance, thread })

// formatThreadAddress encodes a thread address in the actor:instance:thread wire form.
export const formatThreadAddress = (id: ThreadAddress): string => `${id.actor}:${id.instance}:${id.thread}`

// parseThreadAddress decodes an actor:instance:thread wire address.
export const parseThreadAddress = (value: string): ThreadAddress => {
  const actorEnd = value.indexOf(":")
  const instanceEnd = value.indexOf(":", actorEnd + 1)
  if (actorEnd <= 0 || instanceEnd <= actorEnd + 1 || instanceEnd === value.length - 1) {
    throw new Error(`invalid thread address ${JSON.stringify(value)}`)
  }
  return {
    actor: value.slice(0, actorEnd),
    instance: value.slice(actorEnd + 1, instanceEnd),
    thread: value.slice(instanceEnd + 1)
  }
}
