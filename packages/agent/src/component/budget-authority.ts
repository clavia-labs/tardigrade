import type { Event } from "@clavia/tardigrade-core/log/event"
import { HashMap, HashSet, Schema } from "effect"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { intent, type Transition } from "@clavia/tardigrade-core/runtime"
import { handles, component, type Component } from "@clavia/tardigrade-core/actor"
import { formatThreadAddress, isThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
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

type ReceivedBudgetRequest = Event & {
  readonly id?: unknown
  readonly turn?: unknown
  readonly reason?: unknown
  readonly amount?: unknown
  readonly link?: { readonly source?: unknown }
}

interface BudgetAuthorityState {
  readonly next: number
  readonly pending: HashMap.HashMap<string, { readonly order: number; readonly event: ReceivedBudgetRequest }>
  readonly settled: HashSet.HashSet<string>
}

const reduceAuthority = (state: BudgetAuthorityState, event: Event): BudgetAuthorityState => {
  if (event.type === "BudgetRequestDecided" || event.type === "BudgetRequestFailed") {
    const id = String((event as { readonly callId?: unknown }).callId ?? "")
    return {
      ...state,
      pending: HashMap.remove(state.pending, id),
      settled: HashSet.add(state.settled, id)
    }
  }
  if (event.type !== "BudgetRequestReceived") return state
  const received = event as ReceivedBudgetRequest
  const id = String(received.id ?? "")
  return HashSet.has(state.settled, id) || HashMap.has(state.pending, id)
    ? state
    : {
        ...state,
        next: state.next + 1,
        pending: HashMap.set(state.pending, id, { order: state.next, event: received })
      }
}

const authorityTransition = (
  received: ReceivedBudgetRequest | undefined,
  decide: DecideBudget
): Transition<never> | undefined => {
  if (received === undefined) return undefined

  const id = String(received.id ?? "")
  const amount = Number(received.amount ?? 0)
  const request: BudgetRequest = {
    id,
    turn: String(received.turn ?? ""),
    reason: String(received.reason ?? ""),
    amount,
    ...(isThreadAddress(received.link?.source) ? { from: formatThreadAddress(received.link.source) } : {}),
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
  return handles(requestBudgetMethod, component({
    name: "budget-authority",
    keys: budgetAuthorityKeys,
    initial: (): BudgetAuthorityState => ({ next: 0, pending: HashMap.empty(), settled: HashSet.empty() }),
    step: reduceAuthority,
    output: (state) => {
      const received = Array.from(HashMap.values(state.pending))
        .reduce((first, candidate) => first === undefined || candidate.order < first.order ? candidate : first, undefined as { readonly order: number; readonly event: ReceivedBudgetRequest } | undefined)
        ?.event
      const transition = authorityTransition(received, decide)
      return { view: undefined, transitions: transition === undefined ? [] : [transition] }
    }
  }))
}
