import { Clock, Effect } from "effect"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self, effect, type Reactor } from "@clavia/tardigrade-core/actor"
import { budgetRequestReported, replyDelivered } from "../events"
import type { Event } from "@clavia/tardigrade-core/event"
import { boundaryEvent, terminalReportOutcomeOf } from "@clavia/tardigrade-core/communication/message"
import { turnTerminalOf, replyView } from "@clavia/tardigrade-code/turns"
import type { AgentComponent } from "../runtime/agent"
import { reverseLink, type Link } from "@clavia/tardigrade-core/communication/link"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import {
  formatActorId,
  isActorId,
  isProviderEndpoint,
  type ActorId,
  type ProviderEndpoint
} from "@clavia/tardigrade-core/communication/endpoint"

// The reply reactor reports the turn's terminal through the reverse of its accepted inbound link.
// An unlinked inbound settles locally. Sending the envelope is at-least-once across a crash; the receiver dedups
// by the reply's message id (tla/communication/Reply.tla, ReplyReversesAcceptedLink).
//
// Owed work is the reply view: the earliest turn whose terminal is stamped and whose reply is
// not. It lags one stage behind the infer reactor on purpose, so a queued next turn never
// steals a finished turn's reply.

// owedTurn returns the turn being reported: the view's head, and its stamped terminal.
const owedTurn = (
  log: ReadonlyArray<Event>
): {
  readonly id: string
  readonly link?: Link<unknown, ActorId>
  readonly text: string
  readonly outcome: "completed" | "failed"
  readonly round: number
  readonly terminalReport: boolean
} => {
  const view = replyView(log)
  const inbound = view[0] as { id?: unknown; link?: unknown; outcome?: unknown } | undefined
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
      ? { link: inbound.link as Link<unknown, ActorId> }
      : {}),
    text: terminal.error === undefined ? String(terminal.output) : `error: ${String(terminal.error)}`,
    // The outcome rides as a typed field, so a reader never sniffs the text for failure.
    outcome: terminal.error === undefined ? "completed" : "failed",
    round: log.filter((event) =>
      (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
      String((event as { readonly turn?: unknown }).turn) === id
    ).length,
    terminalReport: terminalReportOutcomeOf(inbound) !== undefined
  }
}

const budgetReport = (log: ReadonlyArray<Event>): {
  readonly request: string
  readonly turn: string
  readonly round: number
  readonly reason: string
  readonly amount: number
  readonly link: Link<ActorId, ActorId>
} | undefined => {
  const request = log.find((event) => {
    if (event.type !== "BudgetRequested") return false
    const id = String((event as { readonly callId?: unknown }).callId)
    return !log.some((candidate) =>
      candidate.type === "BudgetRequestReported" &&
      String((candidate as { readonly request?: unknown }).request) === id
    )
  }) as { readonly callId?: unknown; readonly turn?: unknown; readonly reason?: unknown; readonly amount?: unknown } | undefined
  if (request === undefined) return undefined
  const turn = String(request.turn)
  const inbound = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: unknown } | undefined
  if (
    typeof inbound?.link !== "object" ||
    inbound.link === null ||
    !("source" in inbound.link) ||
    !("target" in inbound.link) ||
    !isActorId(inbound.link.source) ||
    !isActorId(inbound.link.target)
  ) return undefined
  return {
    request: String(request.callId),
    turn,
    round: log.filter((event) =>
      (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
      String((event as { readonly turn?: unknown }).turn) === turn
    ).length,
    reason: String(request.reason ?? ""),
    amount: Number(request.amount ?? 0),
    link: inbound.link as Link<ActorId, ActorId>
  }
}

// replyReactor derives one reply per turn: rd:<turn> is the key, the finished turn's terminal is
// the input. The delivery is at-least-once inside the act; the receiver dedups the reply by its
// message id, and the local record commits the key. A terminal report carries `outcome` and
// settles locally because another report would let two agents acknowledge each other without end
// (reply.test.ts, "terminal reports cannot start reply chains").
export const replyReactor: Reactor<Router | Self> = (log) => {
  const request = budgetReport(log)
  const budgetTransitions = request === undefined ? [] : [
    effect({
      key: `brr:${request.request}`,
      input: request,
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const self = yield* Self
          const router = yield* Router
          yield* router.send(envelopeOf(reverseLink(input.link), boundaryEvent({
            turn: input.turn,
            round: input.round,
            text: input.reason,
            outcome: "requesting",
            from: formatActorId(self),
            data: { request: input.request, reason: input.reason, amount: input.amount, round: input.round },
            at
          })))
          return [budgetRequestReported({ request: input.request, turn: input.turn, round: input.round, at })]
        })
    })
  ]
  if (replyView(log).length === 0) return budgetTransitions
  const turn = owedTurn(log)
  return [...budgetTransitions,
    effect({
      key: `rd:${turn.id}`,
      input: turn,
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          if (input.terminalReport) return [replyDelivered({ turn: input.id, at })]
          if (input.link === undefined) return [replyDelivered({ turn: input.id, at })]
          const self = yield* Self
          const event = boundaryEvent({
            turn: input.id,
            round: input.round,
            text: input.text,
            outcome: input.outcome,
            from: formatActorId(self),
            at
          })
          if (isProviderEndpoint(input.link.source)) {
            const router = yield* Router
            yield* router.send(envelopeOf(
              reverseLink(input.link as Link<ProviderEndpoint, ActorId>),
              event
            ))
            return [replyDelivered({ to: input.link.source.provider, turn: input.id, at })]
          }
          if (isActorId(input.link.source)) {
            const router = yield* Router
            yield* router.send(envelopeOf(reverseLink(input.link as Link<ActorId, ActorId>), event))
            return [replyDelivered({ to: formatActorId(input.link.source), turn: input.id, at })]
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
