import { receivedEventOf } from "@clavia/tardigrade-deprecated-core/interaction"
import { hostEventKeyOf } from "@clavia/tardigrade-deprecated-host/event-key"
import { cloudflareRetryPolicy, makeRetryingRpc } from "../retry"
import { Effect } from "effect"
import { traceparentOf } from "@clavia/tardigrade-deprecated-core/log/trace"
import type { Event } from "@clavia/tardigrade-deprecated-core/log/event"
import type { ThreadAddress } from "@clavia/tardigrade-deprecated-core/transport/endpoint"
import type { Transport } from "@clavia/tardigrade-deprecated-core/transport/transport"
import type { ActorEnvelope } from "@clavia/tardigrade-deprecated-core/interaction/envelope"
import type { ChildPlacement } from "@clavia/tardigrade-deprecated-core/interaction/relations"
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
      return Effect.suspend(() => {
        const placement = envelope.lineage?.placement ?? defaultChildPlacement
        if (placement !== "independent") throw new Error(`Cloudflare Durable Object host does not support ${JSON.stringify(placement)} thread placement`)
        if (!deployed(destination.actor)) throw new Error(`actor ${JSON.stringify(destination.actor)} is not deployed`)
        const delivered = {
          ...envelope,
          event,
          ...(envelope.lineage === undefined ? {} : { lineage: { ...envelope.lineage, placement } })
        }
        const rpc = makeRetryingRpc({ retry: cloudflareRetryPolicy(env.TARDIGRADE_CONFIG) })
        const landed = receivedEventOf({ target: destination, event, link: envelope.link, call: envelope.call })
        const replaySafe = hostEventKeyOf(landed) !== undefined || (landed.type === "MessageReceived" && typeof landed.id === "string" && landed.id.length > 0)
        return (envelope.lineage !== undefined
          ? rpc.call(env.ACTORS, actorObjectNameOf(destination.actor, destination.instance), "deliverChild", stub => stub.deliverChild(delivered), replaySafe)
          : rpc.call(env.THREADS, threadObjectNameOf(destination.actor, destination.instance, destination.thread), "deliver", stub => stub.deliver(delivered), replaySafe)
        ).pipe(Effect.orDie)
      })
    })
  )
})
