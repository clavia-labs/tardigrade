import { Schema } from "effect"
import type { Router } from "@clavia/tardigrade-core/transport/router"
import type { Self } from "@clavia/tardigrade-core/runtime"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { BudgetDecision, requestBudgetMethod, type BudgetRequestInput } from "../../actor/budget"
import { budgetRequestDecided, budgetRequestFailed } from "../../log/events"
import { authorityComponent, type AuthorityComponent } from "./authority"
import type { AuthorityTarget } from "./target"
export { caller } from "./target"

export interface BudgetRequest extends BudgetRequestInput {
  readonly id: string
  readonly from?: string
  readonly grant: (amount?: number) => BudgetDecision
  readonly deny: (reason?: string) => BudgetDecision
}
export type DecideBudget = (request: BudgetRequest) => BudgetDecision
export const DEFAULT_BUDGET_DECISION: DecideBudget = (request) => request.grant()
export type BudgetAuthorityMethods = { readonly requestBudget: typeof requestBudgetMethod }
export type BudgetAuthority = AuthorityTarget<BudgetAuthorityMethods>
export type CallerBudgetAuthority = Extract<BudgetAuthority, { readonly kind: "caller" }>
export type BudgetAuthorityOptions =
  | { readonly decide?: DecideBudget; readonly delegate?: never }
  | { readonly delegate: BudgetAuthority; readonly decide?: never }

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

const definition = {
  name: "budget-authority",
  methods: { requestBudget: requestBudgetMethod },
  method: "requestBudget" as const,
  received: "BudgetRequestReceived",
  decided: "BudgetRequestDecided",
  failed: "BudgetRequestFailed",
  keys: budgetAuthorityKeys,
  input: (event: import("@clavia/tardigrade-core/event").Event): BudgetRequestInput => ({
    request: String(event.request ?? ""),
    turn: String(event.turn ?? ""),
    reason: String(event.reason ?? ""),
    amount: Number(event.amount ?? 0)
  }),
  request: ({
    id,
    input,
    from
  }: import("./authority").AuthorityRequest<BudgetRequestInput>): BudgetRequest => ({
    ...input,
    id,
    ...(from === undefined ? {} : { from }),
    grant: (amount = input.amount) => ({ granted: amount }),
    deny: (reason) => ({ denied: true, ...(reason === undefined ? {} : { reason }) })
  }),
  decision: (id: string, proposed: BudgetDecision, at: number) => {
    if ("granted" in proposed && (!Number.isSafeInteger(proposed.granted) || proposed.granted <= 0))
      throw new Error(`budget grant must be a positive integer, got ${JSON.stringify(proposed.granted)}`)
    const decision = Schema.decodeSync(BudgetDecision)(proposed)
    return budgetRequestDecided({
      callId: id,
      grant: "granted" in decision ? decision.granted : 0,
      ...("denied" in decision && decision.reason !== undefined ? { reason: decision.reason } : {}),
      at
    })
  },
  failure: (id: string, error: string, at: number) => budgetRequestFailed({ callId: id, error, at })
}

function create(options: {
  readonly delegate: BudgetAuthority
  readonly decide?: never
}): AuthorityComponent<BudgetRequestInput, BudgetDecision, Router | Self>
function create(options?: {
  readonly decide?: DecideBudget
  readonly delegate?: never
}): AuthorityComponent<BudgetRequestInput, BudgetDecision>
function create(
  options: BudgetAuthorityOptions = {}
): AuthorityComponent<BudgetRequestInput, BudgetDecision, Router | Self> {
  return options.delegate === undefined
    ? authorityComponent(definition, { decide: options.decide ?? DEFAULT_BUDGET_DECISION })
    : authorityComponent(definition, { delegate: options.delegate })
}

// budgetAuthority handles incoming budget requests locally, by delegation, or through manual decisions (authority.test.ts).
export const budgetAuthority = Object.assign(create, {
  manual: (): AuthorityComponent<BudgetRequestInput, BudgetDecision> => authorityComponent(definition)
})
