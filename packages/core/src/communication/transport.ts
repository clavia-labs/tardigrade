import { Context, Effect } from "effect"
import type { Event } from "../event"
import type { ActorAddress, ProviderAddress } from "./address"
import type { Delivery } from "./delivery"
import type { Link } from "./link"
import type { ThreadLineage } from "../thread"

// CallResult is a turn's boundary: a terminal or a park on a budget request.
export interface CallResult {
  readonly output?: string
  readonly error?: string
  readonly requesting?: boolean
  readonly reason?: string
  readonly amount?: number
  readonly callId?: string
}

// Transport carries typed deliveries through the placement and connection selected by its host.
export class Transport extends Context.Service<
  Transport,
  {
    readonly deliver: (
      delivery:
        | Delivery<ActorAddress, Event, ActorAddress>
        | Delivery<ActorAddress, Event, ProviderAddress>
    ) => Effect.Effect<void>
    readonly call: (
      link: Link<ActorAddress, ActorAddress>,
      message: {
        readonly id: string
        readonly text: string
        readonly output?: unknown
        readonly model?: string
        readonly budget?: number
        readonly escalatable?: boolean
        readonly actor?: string
        readonly shadow?: boolean
        readonly world?: string
        readonly lineage: ThreadLineage
      }
    ) => Effect.Effect<CallResult>
    readonly resume: (
      link: Link<ActorAddress, ActorAddress>,
      turn: string,
      decision: { readonly amount: number; readonly reason?: string }
    ) => Effect.Effect<CallResult>
  }
>()("tardigrade/Transport") {}
