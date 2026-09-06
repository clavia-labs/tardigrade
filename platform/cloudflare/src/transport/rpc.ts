import { Effect } from "effect"
import { traceparentOf } from "@clavia/tardigrade-core/log/trace"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Transport } from "@clavia/tardigrade-core/transport/transport"
import type { ActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import type { ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { Env } from "../env"
import { actorObjectNameOf, threadObjectNameOf } from "./directory"

// cloudflareRpcTransport delivers actor envelopes through Durable Object RPC.
export const cloudflareRpcTransport = (
  env: Env,
  { deployed, defaultChildPlacement }: {
    readonly deployed: (name: string) => boolean
    readonly defaultChildPlacement: ChildPlacement
  }
): Transport<ThreadAddress, ActorEnvelope> => ({
  name: "durable-object",
  send: (destination, envelope) => Effect.currentSpan.pipe(
    Effect.option,
    Effect.flatMap((current) => {
      const event = current._tag === "Some" && (envelope.event as { readonly traceparent?: unknown }).traceparent === undefined
        ? ({ ...envelope.event, traceparent: traceparentOf(current.value) } as Event)
        : envelope.event
      return Effect.promise(async () => {
        const placement = envelope.lineage?.placement ?? defaultChildPlacement
        if (placement !== "independent") throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(placement)} thread placement`)
        if (!deployed(destination.actor)) throw new Error(`actor ${JSON.stringify(destination.actor)} is not deployed`)
        const delivered = {
          ...envelope,
          event,
          ...(envelope.lineage === undefined ? {} : { lineage: { ...envelope.lineage, placement } })
        }
        if (envelope.lineage !== undefined) {
          const directory = env.ACTORS.getByName(actorObjectNameOf(destination.actor, destination.instance))
          await directory.deliverChild(delivered)
          return
        }
        const stub = env.THREADS.getByName(threadObjectNameOf(destination.actor, destination.instance, destination.thread))
        await stub.deliver(delivered)
      })
    })
  )
})
