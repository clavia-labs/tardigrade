import { Effect } from "effect"
import { Self, Sessions, type Event } from "@flamecast/core"
import type { Agent, AgentServices, InboundMessage, MessageOrigin, TurnResult } from "./module"
import { usageOf } from "./infer"
import { treeUsageIn } from "./turns"

// One agent, seen the way a runtime sees a session: an event goes in, the terminal event comes out.
//
// This is the whole adapter between the two halves of a multi-agent system. An agent is behavior
// and knows no address; a runtime owns addresses, storage, and leases and knows no agent vocabulary.
// A runtime's registry holds these functions, so the runtime routes to a plain function and never
// learns what a turn is, and an application whose sessions are machines rather than agents supplies
// its own function of the same shape.
//
// The guards live here rather than in the runtime because they read the harness alphabet: `origin`
// on an inbound head is what makes the delegation chain walkable, and a runtime does not know that
// field. They read other sessions through the `Sessions` port, so they work on any runtime that
// serves more than one session.
export type Serve<R = never> = (
  event: Event
) => Effect.Effect<Event, never, AgentServices | Sessions | R>

export interface ServeOptions {
  // The recursion bound. The chain is derived by walking heads through their origins, so the cap
  // needs no carried counter and an application can not forget to decrement it.
  readonly maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 8

const messageOf = (event: Event): InboundMessage => ({
  id: String(event.id ?? ""),
  text: String(event.text ?? ""),
  ...(event.output === undefined ? {} : { output: event.output }),
  ...(typeof event.budget === "number" ? { budget: event.budget } : {}),
  ...(event.escalatable === undefined ? {} : { escalatable: event.escalatable === true }),
  ...(event.replyTo === undefined ? {} : { replyTo: String(event.replyTo) }),
  ...(event.origin === undefined ? {} : { origin: event.origin as MessageOrigin }),
  ...(event.outcome === "completed" || event.outcome === "failed"
    ? { outcome: event.outcome }
    : {}),
  ...(event.usage === undefined ? {} : { usage: usageOf(event.usage) })
})

const failed = (event: Event, error: string): Event => ({
  type: "TurnFailed",
  turn: String(event.id ?? ""),
  error
})

// The terminal event a caller reads, stamped with what the whole turn cost including everything it
// delegated to. Cost folds up the tree because each reply carries the sender's inclusive total.
const terminalOf = (result: TurnResult, log: ReadonlyArray<Event>): Event => {
  const usage = treeUsageIn(log, result.turn)
  switch (result.kind) {
    case "completed":
      return { type: "TurnCompleted", turn: result.turn, output: result.output, usage }
    case "failed":
      return { type: "TurnFailed", turn: result.turn, error: result.error, usage }
    case "parked":
      // The event that parked the turn is the event that ended the settle. A caller that wants to
      // grant the ask delivers the grant, which wakes the turn where it stopped.
      return {
        type: "BudgetRequested",
        turn: result.turn,
        callId: result.callId,
        reason: result.reason,
        amount: result.amount,
        usage
      }
    case "open":
      return {
        type: "TurnFailed",
        turn: result.turn,
        error: "the turn settled without a terminal",
        usage
      }
  }
}

// The ancestry of a delivery, derived: each origin names a session and the turn that sent, and that
// turn's head names its own origin. A hop into a session the runtime does not hold ends the chain
// with what is known.
const ancestry = (origin: MessageOrigin | undefined, maxDepth: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const chain: Array<string> = []
    let cursor = origin
    while (cursor !== undefined && chain.length <= maxDepth) {
      const current = cursor
      chain.push(current.session)
      const rows = yield* sessions.read(current.session)
      if (rows.length === 0) break
      const head = rows.find(
        (event) => event.type === "MessageReceived" && String(event.id ?? "") === current.turn
      )
      cursor = head?.origin as MessageOrigin | undefined
    }
    return chain
  })

export const serve = <R = never>(
  agent: Agent<AgentServices | R, any>,
  options: ServeOptions = {}
): Serve<R> => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  return (event) =>
    Effect.gen(function* () {
      const origin = event.origin as MessageOrigin | undefined
      if (origin !== undefined) {
        const here = yield* Self
        const chain = yield* ancestry(origin, maxDepth)
        // A cycle would deadlock: this session's writer is about to be held while it waits on a
        // chain that comes back to it. Refusing is the honest answer, and it arrives as an ordinary
        // failed turn the caller can read.
        if (chain.includes(here)) {
          return failed(event, `delegation cycle: "${here}" is already serving this request`)
        }
        if (chain.length >= maxDepth) {
          return failed(event, `delegation depth reached the bound of ${maxDepth}`)
        }
      }
      // A message opens a turn. Any other event is a delivery the session absorbs, which is how a
      // budget grant wakes a parked turn: append, settle, and report where the turn now stands.
      const result =
        event.type === "MessageReceived"
          ? yield* agent.turn(messageOf(event))
          : yield* agent.replay([event])
      return terminalOf(result, yield* agent.log)
    })
}
