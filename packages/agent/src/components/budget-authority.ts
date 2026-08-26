import type { Event } from "@clavia/tardigrade-core/log/event"
import { Schema } from "effect"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { intent, type Transition } from "@clavia/tardigrade-core/reconciliation"
import { handles, type Component } from "@clavia/tardigrade-core/actor"
import { formatActorId, isActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { BudgetDecision } from "../actor/budget"
import { budgetRequestDecided, budgetRequestFailed } from "../log/events"
import { requestBudgetMethod } from "../actor/budget"

// BudgetRequest describes one durable authority call and supplies its valid decisions.
export interface BudgetRequest {
  readonly id: string
  readonly reason: string
  readonly amount: number
  readonly turn: string
  readonly from?: string
  readonly grant: (amount?: number) => BudgetDecision
  readonly deny: (reason?: string) => BudgetDecision
}

// DecideBudget is the pure local policy implemented by budgetAuthority.
export type DecideBudget = (request: BudgetRequest) => BudgetDecision

// DEFAULT_BUDGET_DECISION grants the number of tool calls the child requested.
export const DEFAULT_BUDGET_DECISION: DecideBudget = (request) => request.grant()

export interface BudgetAuthorityOptions {
  readonly decide?: DecideBudget
}

// budgetAuthorityKeys owns budget authority calls and their terminal outcomes.
export const budgetAuthorityKeys: KeyFragment = {
  prefixes: ["bar:", "ba:"],
  keyOf: (event) => {
    const value = event as Record<string, unknown>
    if (event.type === "BudgetRequestReceived") return `bar:${String(value.id)}`
    return event.type === "BudgetRequestDecided" || event.type === "BudgetRequestFailed"
      ? `ba:${String(value.callId)}`
      : undefined
  }
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

const authorityTransition = (
  log: ReadonlyArray<Event>,
  decide: DecideBudget
): Transition<never> | undefined => {
  const received = log.find((event) =>
    event.type === "BudgetRequestReceived" &&
    !log.some((terminal) =>
      (terminal.type === "BudgetRequestDecided" || terminal.type === "BudgetRequestFailed") &&
      String((terminal as { readonly callId?: unknown }).callId) === String((event as { readonly id?: unknown }).id)
    )
  ) as {
    readonly id?: unknown
    readonly turn?: unknown
    readonly reason?: unknown
    readonly amount?: unknown
    readonly link?: { readonly source?: unknown }
  } | undefined
  if (received === undefined) return undefined

  const id = String(received.id ?? "")
  const amount = Number(received.amount ?? 0)
  const request: BudgetRequest = {
    id,
    turn: String(received.turn ?? ""),
    reason: String(received.reason ?? ""),
    amount,
    ...(isActorId(received.link?.source) ? { from: formatActorId(received.link.source) } : {}),
    grant: (granted = amount) => ({ granted }),
    deny: (reason) => ({ denied: true, ...(reason === undefined ? {} : { reason }) })
  }

  try {
    const proposed = decide(request)
    if ("granted" in proposed && (!Number.isSafeInteger(proposed.granted) || proposed.granted <= 0)) {
      throw new Error(`budget grant must be a positive integer, got ${JSON.stringify(proposed.granted)}`)
    }
    const decision = Schema.decodeSync(BudgetDecision)(proposed)
    if ("granted" in decision) {
      const grant = decision.granted
      return intent({
        key: `ba:${id}`,
        input: { id, grant },
        events: (input, at) => [budgetRequestDecided({ callId: input.id, grant: input.grant, at })]
      })
    }
    return intent({
      key: `ba:${id}`,
      input: { id, reason: decision.reason },
      events: (input, at) => [budgetRequestDecided({
        callId: input.id,
        grant: 0,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        at
      })]
    })
  } catch (failure) {
    return intent({
      key: `ba:${id}`,
      input: { id, error: failureMessage(failure) },
      events: (input, at) => [budgetRequestFailed({ callId: input.id, error: input.error, at })]
    })
  }
}

// budgetAuthority handles requestBudget with a pure local decision policy.
export const budgetAuthority = (options: BudgetAuthorityOptions = {}): Component<undefined> => {
  const decide = options.decide ?? DEFAULT_BUDGET_DECISION
  return handles(requestBudgetMethod, {
    name: "budget-authority",
    keys: budgetAuthorityKeys,
    derive: (log) => {
      const transition = authorityTransition(log, decide)
      return { view: undefined, transitions: transition === undefined ? [] : [transition] }
    }
  })
}
