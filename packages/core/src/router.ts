import { Context, Effect } from "effect"
import type { Event } from "./event"

// CallResult is a turn's boundary: a terminal (output or error), or a park on a budget ask
// (requesting, with the reason, the amount, and the call the parent's decision answers). One
// shape serves call and resume.
export interface CallResult {
  readonly output?: string
  readonly error?: string
  readonly requesting?: boolean
  readonly reason?: string
  readonly amount?: number
  readonly callId?: string
}

// address formats home:facet; readAddress splits on the first colon. The home is the
// principal; the facet names the lane.
export const address = (home: string, facet: string): string => `${home}:${facet}`
export const readAddress = (a: string): { readonly home: string; readonly facet: string } => {
  const i = a.indexOf(":")
  return i === -1 ? { home: a, facet: "main" } : { home: a.slice(0, i), facet: a.slice(i + 1) }
}

// Router reaches one actor from another. An address names an actor; delivery is at-least-once
// and every receiver dedups by message id. deliver is the async door: append to the target,
// settle eventually. call is the sync door: run the target to quiescence, return its terminal.
// A call cycle deadlocks on per-actor serialization, so long work goes through deliver with the
// reply coming home as an inbound.
export class Router extends Context.Service<
  Router,
  {
    readonly deliver: (address: string, event: Event) => Effect.Effect<void>
    readonly call: (
      address: string,
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
    // resume answers a budget ask: grant when amount > 0, deny otherwise, then run the target
    // to its next boundary.
    readonly resume: (
      address: string,
      turn: string,
      decision: { readonly amount: number; readonly reason?: string }
    ) => Effect.Effect<CallResult>
  }
>()("flamecast/Router") {}
