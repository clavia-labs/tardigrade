import { Context, Data, Effect } from "effect"
import {
  linkedEventOf,
  type Delivery,
  type LinkedEvent
} from "@clavia/tardigrade-core/communication/delivery"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"

// IngressActor commits one canonical inbound and schedules its actor driver.
export interface IngressActor {
  readonly commit: (thread: string, event: LinkedEvent<unknown, MessageReceived>) => Effect.Effect<void>
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
    readonly commit: (deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void, ActorUnavailable>
    readonly schedule: (deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void, ActorUnavailable>
  }
>()("tardigrade/host/Ingress") {}

// ingressFrom binds actor names to host doors. It resolves the complete batch before writing, so an unavailable actor leaves every delivery in that batch uncommitted.
export const ingressFrom = (
  actorFor: (actor: string) => IngressActor | undefined
): Context.Service.Shape<typeof Ingress> => {
  const resolve = (deliveries: ReadonlyArray<Delivery>) =>
    Effect.gen(function* () {
      const routed: Array<{ readonly delivery: Delivery; readonly target: IngressActor }> = []
      for (const delivery of deliveries) {
        const target = actorFor(delivery.link.target.actor)
        if (target === undefined) {
          return yield* Effect.fail(new ActorUnavailable({ actor: delivery.link.target.actor }))
        }
        routed.push({ delivery, target })
      }
      return routed
    })

  return {
    commit: (deliveries) =>
      Effect.flatMap(resolve(deliveries), (routed) =>
        Effect.forEach(
          routed,
          ({ delivery, target }) =>
            target.commit(
              delivery.link.target.thread,
              linkedEventOf(delivery as Delivery<unknown, MessageReceived>)
            ),
          { discard: true }
        )
      ),
    schedule: (deliveries) =>
      Effect.flatMap(resolve(deliveries), (routed) => {
        const scheduled = new Set<string>()
        return Effect.forEach(
          routed,
          ({ delivery, target }) => {
            if (scheduled.has(delivery.link.target.actor)) return Effect.void
            scheduled.add(delivery.link.target.actor)
            return target.schedule
          },
          { discard: true }
        )
      })
  }
}
