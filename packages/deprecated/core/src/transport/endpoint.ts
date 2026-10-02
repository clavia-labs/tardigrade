import { Schema } from "effect"
import { actorCoordinateOf, ThreadCoordinate, threadCoordinateOf } from "../actor/coordinate"

import { legacyThreadAddressOf, parseLegacyThreadAddress } from "./address-compat"

export { ACTOR_INSTANCE_ID_PATTERN, ActorInstanceId, isActorInstanceId } from "../actor/coordinate"

// ThreadAddress is the compatibility name for ThreadCoordinate.
export const ThreadAddress = ThreadCoordinate
export type ThreadAddress = ThreadCoordinate

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
export const threadAddressOf = (actor: string, instance: string, thread: string): ThreadAddress =>
  threadCoordinateOf(actorCoordinateOf(actor, instance), thread)

// formatThreadAddress encodes coordinates losslessly while retaining representable legacy addresses (endpoint.test.ts).
export const formatThreadAddress = (id: ThreadAddress): string => {
  if (!isThreadAddress(id)) throw new Error(`invalid thread address ${JSON.stringify(id)}`)
  return legacyThreadAddressOf(id) ?? JSON.stringify([id.actor, id.instance, id.thread])
}

// parseThreadAddress decodes tuple addresses and persisted legacy addresses.
export const parseThreadAddress = (value: string): ThreadAddress => {
  if (value.startsWith("[")) {
    let tuple: unknown
    try { tuple = JSON.parse(value) } catch { return parseLegacyThreadAddress(value) }
    if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every((part) => typeof part === "string")) {
      throw new Error(`invalid thread address ${JSON.stringify(value)}`)
    }
    return threadAddressOf(tuple[0]!, tuple[1]!, tuple[2]!)
  }
  return parseLegacyThreadAddress(value)
}
