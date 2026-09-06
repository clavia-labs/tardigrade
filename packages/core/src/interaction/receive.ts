import type { Event } from "../event"
import type { Link } from "../transport/link"
import { sameThreadAddress } from "./relations"
import type { ThreadCoordinate } from "../actor/coordinate"
import { decodeActorInvocationContext, sameInvocation } from "./invocation"

import { linkedEventOf } from "./envelope"

// receivedEventOf validates invocation context before host persistence (receive.test.ts).
// TODO: Require receiver-side capability validation here, with credentials outside the durable event.
export const receivedEventOf = (delivery: {
  readonly target: ThreadCoordinate
  readonly event: Event
  readonly link?: Link<unknown, ThreadCoordinate>
  readonly call?: unknown
}): Event => {
  const { target, event, link } = delivery
  if (link !== undefined && !sameThreadAddress(target, link.target)) throw new Error("delivery link does not match target")
  const embedded = typeof event.call === "object" && event.call !== null
    ? decodeActorInvocationContext(event.call) : undefined
  const context = delivery.call === undefined ? embedded : decodeActorInvocationContext(delivery.call)
  if (embedded !== undefined && context !== undefined && (
    !sameInvocation(embedded.invocation, context.invocation) || embedded.deadlineAt !== context.deadlineAt ||
    (embedded.parent === undefined ? context.parent !== undefined :
      context.parent === undefined || !sameInvocation(embedded.parent, context.parent))
  )) throw new Error("delivery context does not match event context")
  const accepted = context === undefined ? event : { ...event, call: context }
  return link !== undefined && (event.type === "MessageReceived" || context !== undefined)
    ? linkedEventOf({ link, event: accepted, ...(context === undefined ? {} : { call: context }) })
    : accepted
}
