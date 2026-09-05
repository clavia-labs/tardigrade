import type { Event } from "@clavia/tardigrade-core/event"

// METHOD_SEALED_EVENT_TYPE names the durable event that permanently closes one method's admission.
export const METHOD_SEALED_EVENT_TYPE = "MethodSealed" as const

// MethodSealed is the durable seal itself: once stored, the method never admits another call.
export interface MethodSealed extends Event {
  readonly type: typeof METHOD_SEALED_EVENT_TYPE
  readonly method: string
  readonly reason?: string
  readonly at: number
}

// methodSealed constructs the seal event, refusing an empty method or an unsafe time (seal.test.ts,
// "the seal constructor refuses an empty method and an unsafe time").
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

// methodSealOf decodes the seal carried by an event, undefined for any other event or a malformed seal.
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

// methodIsSealed reports whether the log already sealed the method (seal.test.ts, "a sealed method stays sealed").
export const methodIsSealed = (events: ReadonlyArray<Event>, method: string): boolean =>
  events.some((event) => methodSealOf(event)?.method === method)
