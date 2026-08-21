import { Context, Effect } from "effect"
import type { Event } from "../event"
import type { ActorAddress, ProviderAddress } from "./address"
import type { Link } from "./link"

// CallResult is a turn's boundary: a terminal or a park on a budget request.
export interface CallResult {
  readonly output?: string
  readonly error?: string
  readonly requesting?: boolean
  readonly reason?: string
  readonly amount?: number
  readonly callId?: string
}

// Router interprets typed actor links through the placement and transport selected by its host.
export class Router extends Context.Service<
  Router,
  {
    readonly deliver: (
      link: Link<ActorAddress, ActorAddress> | Link<ActorAddress, ProviderAddress>,
      event: Event
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
      }
    ) => Effect.Effect<CallResult>
    readonly resume: (
      link: Link<ActorAddress, ActorAddress>,
      turn: string,
      decision: { readonly amount: number; readonly reason?: string }
    ) => Effect.Effect<CallResult>
  }
>()("tardigrade/Router") {}
