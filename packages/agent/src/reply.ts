import { Clock, Effect } from "effect"
import { Router } from "@clavia/tardigrade-core/router"
import { Self, transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { replyDelivered } from "./events"
import type { Event } from "@clavia/tardigrade-core/event"
import { replyEvent } from "@clavia/tardigrade-core/reply"
import { replyView } from "@clavia/tardigrade-code/turns"

// The reply reactor: report the turn's terminal home. When the inbound named a `replyTo`, the
// terminal goes back to that actor as a plain `MessageReceived`, and the caller folds it as a
// fresh turn. When it named none, it records that nothing was owed. Delivery is at-least-once
// across a crash; the receiver dedups by the reply's message id.
//
// Owed work is the reply view: the earliest turn whose terminal is stamped and whose reply is
// not. It lags one stage behind the infer reactor on purpose, so a queued next turn never
// steals a finished turn's reply.

// owedTurn returns the turn being reported: the view's head, and its stamped terminal.
const owedTurn = (
  log: ReadonlyArray<Event>
): { readonly id: string; readonly replyTo?: string; readonly text: string; readonly outcome: "completed" | "failed" } => {
  const view = replyView(log)
  const inbound = view[0] as { id?: unknown; replyTo?: unknown } | undefined
  const terminal = view.find((e) => e.type === "TurnCompleted" || e.type === "TurnFailed") as
    | { output?: unknown; error?: unknown }
    | undefined
  if (inbound === undefined || terminal === undefined) {
    throw new Error("replying with no finished turn: the derivation and the serve disagree")
  }
  return {
    id: String(inbound.id),
    ...(inbound.replyTo === undefined ? {} : { replyTo: String(inbound.replyTo) }),
    text: terminal.error === undefined ? String(terminal.output) : `error: ${String(terminal.error)}`,
    // The outcome rides as a typed field, so a reader never sniffs the text for failure.
    outcome: terminal.error === undefined ? "completed" : "failed"
  }
}

// replyReactor derives one reply per turn: rd:<turn> is the key, the finished turn's terminal is
// the input. The delivery is at-least-once inside the act; the receiver dedups the reply by its
// message id, and the local record commits the key.
export const replyReactor: Reactor<Router | Self> = (log) => {
  if (replyView(log).length === 0) return []
  const turn = owedTurn(log)
  return [
    transition({
      key: `rd:${turn.id}`,
      input: turn,
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          if (input.replyTo === undefined) {
            return [replyDelivered({ turn: input.id, at })]
          }
          const router = yield* Router
          const self = yield* Self
          yield* router.deliver(
            input.replyTo,
            replyEvent({ id: input.id, text: input.text, outcome: input.outcome, from: self, at })
          )
          return [replyDelivered({ to: input.replyTo, turn: input.id, at })]
        })
    })
  ]
}
