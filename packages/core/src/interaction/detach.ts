import { Schema } from "effect"
import type { Event } from "../event"
import type { KeyFragment } from "../log"
import { InvocationCoordinate, invocationCoordinateKey, sameInvocation } from "./invocation"
import type { ResponseDelivered } from "./events"

export const InvocationDetached = Schema.Struct({
  type: Schema.Literal("InvocationDetached"),
  direction: Schema.Literals(["outgoing", "incoming"]),
  reference: InvocationCoordinate,
  at: Schema.Finite
})

export type InvocationDetached = typeof InvocationDetached.Type

export const invocationDetached = (fields: Omit<InvocationDetached, "type">): InvocationDetached =>
  Schema.decodeSync(InvocationDetached)({ ...fields, type: "InvocationDetached" })

export const invocationDetachedOf = (event: Event): InvocationDetached | undefined =>
  Schema.is(InvocationDetached)(event) ? event : undefined

export const invocationDetachmentKeys: KeyFragment = {
  prefixes: ["mdetach:"],
  keyOf: (event) => {
    const detached = invocationDetachedOf(event)
    return detached === undefined ? undefined : `mdetach:${detached.direction}:${invocationCoordinateKey(detached.reference)}`
  }
}

export type ReplyState =
  | { readonly status: "pending" }
  | { readonly status: "sent"; readonly delivery: ResponseDelivered }
  | { readonly status: "detached"; readonly detachment: InvocationDetached }

// reduceReplyState preserves the first terminal for the accepted invocation (detach.test.ts).
export const reduceReplyState = (state: ReplyState, event: Event, reference: InvocationCoordinate): ReplyState => {
  if (state.status !== "pending") return state
  const detached = invocationDetachedOf(event)
  if (detached?.direction === "incoming" && invocationCoordinateKey(detached.reference) === invocationCoordinateKey(reference)) {
    return { status: "detached", detachment: detached }
  }
  if (event.type === "ResponseDelivered") {
    const delivery = event as ResponseDelivered
    if (sameInvocation({ method: delivery.method, id: delivery.call, epoch: delivery.epoch ?? 0 }, reference.invocation)) {
      return { status: "sent", delivery }
    }
  }
  return state
}

export const replyStateOf = (events: ReadonlyArray<Event>, reference: InvocationCoordinate): ReplyState =>
  events.reduce<ReplyState>((state, event) => reduceReplyState(state, event, reference), { status: "pending" })
