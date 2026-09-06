import { Effect } from "effect"
import type { Event } from "../event"
import { Self } from "../runtime/reconciler"
import { Router } from "../transport/router"
import type { ThreadAddress } from "../transport/endpoint"
import { linkOf } from "../transport/link"
import { methodEnvelopeOf } from "./envelope"
import type { ThreadLineage } from "./relations"
import type { ActorInvocationContext } from "./invocation"

// sendInvocation publishes a method invocation after its caller has recorded ownership.
export const sendInvocation = (options: {
  readonly target: ThreadAddress
  readonly context: ActorInvocationContext
  readonly event: Event
  readonly lineage?: ThreadLineage
}) => Effect.gen(function* () {
  const source = yield* Self
  const router = yield* Router
  yield* router.send(methodEnvelopeOf(linkOf(source, options.target), options.context, options.event, options.lineage))
})
