import type { Event } from "../event"
import { parseThreadAddress } from "../transport/endpoint"
import { invocationCoordinateKey, type InvocationCoordinate } from "./invocation"
import { invocationDetached, replyStateOf } from "./detach"
import { callStateOf } from "./result"
import { childInvocationsOf } from "./relations"
import { acceptedCallOf, recordedDispatchOf } from "./records-compat"
import type { CallPlanned } from "./events"

// forkDetachmentsOf closes pending copied interactions using their original coordinates (log/fork.test.ts).
export const forkDetachmentsOf = (events: ReadonlyArray<Event>, at: number): ReadonlyArray<Event> => {
  const outgoing = new Map<string, InvocationCoordinate>()
  const incoming = new Map<string, InvocationCoordinate>()
  const remember = (references: Map<string, InvocationCoordinate>, reference: InvocationCoordinate) => {
    references.set(invocationCoordinateKey(reference), reference)
  }
  for (const link of childInvocationsOf(events)) {
    remember(outgoing, { target: parseThreadAddress(link.target), invocation: link.child.invocation })
  }
  for (const event of events) {
    const dispatch = recordedDispatchOf(event)
    if (dispatch !== undefined) remember(outgoing, dispatch.reference)
    if (event.type === "CallPlanned") {
      const plan = event as CallPlanned
      remember(outgoing, plan.reference ?? { target: parseThreadAddress(plan.target), invocation: plan.context.invocation })
    }
    const call = acceptedCallOf(event)
    if (call !== undefined) {
      if (call.invocation === undefined) throw new Error("cannot detach a legacy reply link without an invocation identity")
      remember(incoming, { target: call.link.target, invocation: call.invocation })
    }
  }
  return [
    ...[...outgoing.values()].filter((reference) => callStateOf(events, reference).status === "pending")
      .map((reference) => invocationDetached({ reference, direction: "outgoing", at })),
    ...[...incoming.values()].filter((reference) => replyStateOf(events, reference).status === "pending")
      .map((reference) => invocationDetached({ reference, direction: "incoming", at }))
  ]
}
