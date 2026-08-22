import { Clock, Effect } from "effect"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self, transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { replyDelivered } from "../events"
import type { Event } from "@clavia/tardigrade-core/event"
import { replyEvent, terminalReportOutcomeOf } from "@clavia/tardigrade-core/communication/message"
import { turnTerminalOf, replyView } from "@clavia/tardigrade-code/turns"
import type { AgentComponent } from "../runtime/agent"
import { linkOf, reverseLink, type Link } from "@clavia/tardigrade-core/communication/link"
import {
  formatActorAddress,
  isActorAddress,
  isProviderAddress,
  parseActorAddress,
  type ActorAddress,
  type ProviderAddress
} from "@clavia/tardigrade-core/communication/address"

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
): {
  readonly id: string
  readonly link?: Link<unknown, ActorAddress>
  readonly replyTo?: string
  readonly text: string
  readonly outcome: "completed" | "failed"
  readonly terminalReport: boolean
} => {
  const view = replyView(log)
  const inbound = view[0] as { id?: unknown; link?: unknown; replyTo?: unknown; outcome?: unknown } | undefined
  const id = String(inbound?.id)
  const terminal = turnTerminalOf(log, id) as
    | { output?: unknown; error?: unknown }
    | undefined
  if (inbound === undefined || terminal === undefined) {
    throw new Error("replying with no finished turn: the derivation and the serve disagree")
  }
  return {
    id,
    ...(typeof inbound.link === "object" && inbound.link !== null && "source" in inbound.link && "target" in inbound.link
      ? { link: inbound.link as Link<unknown, ActorAddress> }
      : {}),
    ...(inbound.replyTo === undefined ? {} : { replyTo: String(inbound.replyTo) }),
    text: terminal.error === undefined ? String(terminal.output) : `error: ${String(terminal.error)}`,
    // The outcome rides as a typed field, so a reader never sniffs the text for failure.
    outcome: terminal.error === undefined ? "completed" : "failed",
    terminalReport: terminalReportOutcomeOf(inbound) !== undefined
  }
}

// replyReactor derives one reply per turn: rd:<turn> is the key, the finished turn's terminal is
// the input. The delivery is at-least-once inside the act; the receiver dedups the reply by its
// message id, and the local record commits the key. A terminal report carries `outcome` and
// settles locally because another report would let two agents acknowledge each other without end
// (reply.test.ts, "terminal reports cannot start reply chains").
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
          if (input.terminalReport) return [replyDelivered({ turn: input.id, at })]
          const self = yield* Self
          const event = replyEvent({
            id: input.id,
            text: input.text,
            outcome: input.outcome,
            from: formatActorAddress(self),
            at
          })
          if (input.link !== undefined && isProviderAddress(input.link.source)) {
            const router = yield* Router
            yield* router.deliver(
              reverseLink(input.link as Link<ProviderAddress, ActorAddress>),
              event
            )
            return [replyDelivered({ to: input.link.source.provider, turn: input.id, at })]
          }
          if (input.link !== undefined && isActorAddress(input.link.source)) {
            const router = yield* Router
            yield* router.deliver(reverseLink(input.link as Link<ActorAddress, ActorAddress>), event)
            return [replyDelivered({ to: formatActorAddress(input.link.source), turn: input.id, at })]
          }
          if (input.replyTo !== undefined) {
            const router = yield* Router
            yield* router.deliver(linkOf(self, parseActorAddress(input.replyTo)), event)
            return [replyDelivered({ to: input.replyTo, turn: input.id, at })]
          }
          return [replyDelivered({ turn: input.id, at })]
        })
    })
  ]
}

// reply derives parent-delivery transitions and contributes an empty agent view.
export const reply: AgentComponent<Router | Self> = {
  name: "reply",
  derive: (log) => ({
    view: { system: [], tools: [], context: [], output: [] },
    transitions: replyReactor(log)
  })
}
