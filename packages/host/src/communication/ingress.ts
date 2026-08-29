import { Context, Data, Effect } from "effect"
import type { ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import type { ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { Directory } from "@clavia/tardigrade-core/communication/directory"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"

// IngressActor commits one canonical inbound and schedules its actor driver.
export interface IngressActor {
  readonly commit: (envelope: ActorEnvelope<MessageReceived>) => Effect.Effect<void>
  readonly schedule: Effect.Effect<void>
}

// ActorUnavailable identifies a delivery whose deployed actor cannot be resolved by this host.
export class ActorUnavailable extends Data.TaggedError("ActorUnavailable")<{
  readonly actor: string
}> {}

// Ingress commits addressed inbound batches before a transport acknowledges their receipt.
export class Ingress extends Context.Service<
  Ingress,
  {
    readonly commit: (envelopes: ReadonlyArray<ActorEnvelope<MessageReceived>>) => Effect.Effect<void, ActorUnavailable>
    readonly schedule: (envelopes: ReadonlyArray<ActorEnvelope<MessageReceived>>) => Effect.Effect<void, ActorUnavailable>
  }
>()("tardigrade/host/Ingress") {}

// ingressFrom binds actor identities to host doors through a Directory. It resolves the complete batch before writing, so an unavailable actor leaves every envelope in that batch uncommitted.
export const ingressFrom = (
  directory: Directory<ThreadAddress, IngressActor>
): Context.Service.Shape<typeof Ingress> => {
  const resolve = (envelopes: ReadonlyArray<ActorEnvelope<MessageReceived>>) =>
    Effect.gen(function* () {
      const routed: Array<{ readonly envelope: ActorEnvelope<MessageReceived>; readonly target: IngressActor }> = []
      for (const envelope of envelopes) {
        const target = yield* directory.resolve(envelope.link.target)
        if (target === undefined) {
          return yield* new ActorUnavailable({ actor: envelope.link.target.actor })
        }
        routed.push({ envelope, target })
      }
      return routed
    })

  return {
    commit: (envelopes) =>
      Effect.flatMap(resolve(envelopes), (routed) =>
        Effect.forEach(
          routed,
          ({ envelope, target }) => target.commit(envelope),
          { discard: true }
        )
      ),
    schedule: (envelopes) =>
      Effect.flatMap(resolve(envelopes), (routed) => {
        const scheduled = new Set<string>()
        return Effect.forEach(
          routed,
          ({ envelope, target }) => {
            if (scheduled.has(envelope.link.target.actor)) return Effect.void
            scheduled.add(envelope.link.target.actor)
            return target.schedule
          },
          { discard: true }
        )
      })
  }
}
