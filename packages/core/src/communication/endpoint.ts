import { Schema } from "effect"

// ACTOR_INSTANCE_ID_PATTERN accepts a non-empty identifier that cannot consume the thread-address delimiter.
export const ACTOR_INSTANCE_ID_PATTERN = /^[^:]+$/u

export const ActorInstanceId = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => ACTOR_INSTANCE_ID_PATTERN.test(value), {
    title: `actor instance id matching ${String(ACTOR_INSTANCE_ID_PATTERN)}`
  }))
).annotate({ identifier: "ActorInstanceId" })

export type ActorInstanceId = typeof ActorInstanceId.Type

// isActorInstanceId reports whether a value is a valid actor instance identifier.
export const isActorInstanceId = (value: unknown): value is ActorInstanceId => Schema.is(ActorInstanceId)(value)

// ThreadAddress identifies one durable thread under one actor instance independently of its activation and placement.
export const ThreadAddress = Schema.Struct({
  actor: Schema.String,
  instance: ActorInstanceId,
  thread: Schema.String
}).annotate({ identifier: "ThreadAddress" })

export type ThreadAddress = typeof ThreadAddress.Type

// isThreadAddress reports whether an unknown endpoint identifies an actor thread.
export const isThreadAddress = (endpoint: unknown): endpoint is ThreadAddress => Schema.is(ThreadAddress)(endpoint)

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
export const threadAddressOf = (actor: string, instance: string, thread: string): ThreadAddress => {
  if (!isActorInstanceId(instance)) throw new Error(`invalid actor instance id ${JSON.stringify(instance)}`)
  return { actor, instance, thread }
}

// formatThreadAddress encodes a thread address in the actor:instance:thread wire form.
export const formatThreadAddress = (id: ThreadAddress): string => {
  if (!isThreadAddress(id)) throw new Error(`invalid thread address ${JSON.stringify(id)}`)
  return `${id.actor}:${id.instance}:${id.thread}`
}

// parseThreadAddress decodes an actor:instance:thread wire address.
export const parseThreadAddress = (value: string): ThreadAddress => {
  const actorEnd = value.indexOf(":")
  const instanceEnd = value.indexOf(":", actorEnd + 1)
  if (actorEnd <= 0 || instanceEnd <= actorEnd + 1 || instanceEnd === value.length - 1) {
    throw new Error(`invalid thread address ${JSON.stringify(value)}`)
  }
  return threadAddressOf(
    value.slice(0, actorEnd),
    value.slice(actorEnd + 1, instanceEnd),
    value.slice(instanceEnd + 1)
  )
}
