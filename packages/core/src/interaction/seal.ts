import type { Event } from "@clavia/tardigrade-core/event"
import type { KeyFragment } from "../log/keys"

// METHOD_SEALED_EVENT_TYPE names the durable event that permanently closes one method's admission.
export const METHOD_SEALED_EVENT_TYPE = "MethodSealed" as const

// MethodSealed is the durable seal for one method on one thread.
export interface MethodSealed extends Event {
  readonly type: typeof METHOD_SEALED_EVENT_TYPE
  readonly method: string
  readonly reason?: string
  readonly at: number
}

// methodSealed constructs a valid durable method seal.
export const methodSealed = (fields: {
  readonly method: string
  readonly reason?: string
  readonly at: number
}): MethodSealed => {
  if (fields.method.length === 0) throw new Error("sealed method must not be empty")
  if (!Number.isSafeInteger(fields.at) || fields.at < 0) {
    throw new Error("sealed method time must be a non-negative safe integer")
  }
  return {
    type: METHOD_SEALED_EVENT_TYPE,
    method: fields.method,
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    at: fields.at
  }
}

// methodSealOf decodes a valid seal and ignores every other event.
export const methodSealOf = (event: Event): MethodSealed | undefined => {
  if (event.type !== METHOD_SEALED_EVENT_TYPE) return undefined
  if (
    typeof event.method !== "string" ||
    event.method.length === 0 ||
    !Number.isSafeInteger(event.at) ||
    Number(event.at) < 0 ||
    (event.reason !== undefined && typeof event.reason !== "string")
  ) return undefined
  return event as MethodSealed
}

// methodIsSealed reports whether the log permanently closed the method.
export const methodIsSealed = (events: ReadonlyArray<Event>, method: string): boolean =>
  events.some((event) => methodSealOf(event)?.method === method)

// methodSealKey identifies the durable seal for one method on one thread.
export const methodSealKey = (method: string): string => `mseal:${JSON.stringify(method)}`

// methodSealKeys gives each method one durable seal occurrence.
export const methodSealKeys: KeyFragment = {
  prefixes: ["mseal:"],
  keyOf: (event) => {
    const seal = methodSealOf(event)
    return seal === undefined ? undefined : methodSealKey(seal.method)
  }
}
