import type { ActService } from "@clavia/tardigrade-experimental-core"
import { AskBudget, requests } from "../acts"
import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { atom, effectAtom, type Atom, eventValue, type ActorOutput } from "@clavia/tardigrade-experimental-core"
import { ToolBudgetState, toolBudgetState, type ToolState } from "../projections"
import { BudgetConfigured, BudgetUpdated, BudgetResolved, ToolCalled, ModelCalled, TurnSettled, BudgetPolicy, BudgetDecision, type Event } from "../event"
import { BudgetRequestInput } from "../budget-contracts"

export type ToolBudgetView<R = never> = ActorOutput<{
  readonly requestTool?: string
  readonly exhausted?: boolean
  readonly configured: boolean
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly decision: { readonly allowed: boolean; readonly reason: string } | null
  readonly request: { readonly callId: string; readonly reason: string } | null
  readonly response?: typeof BudgetDecision.Type | { readonly error: string }
}, Event, R>

export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number }): Atom<ToolBudgetView>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool: string }): Atom<ToolBudgetView<ActService<"agent.budget.request">>>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly configure: false }): Atom<ToolBudgetView>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool?: string } | { readonly configure: false }): Atom<ToolBudgetView<ActService<"agent.budget.request">>> {
  if ("maxCalls" in options && (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0)) throw new RuntimeError("maxCalls must be a nonnegative safe integer")
  const initialPolicy = "maxCalls" in options ? Schema.decodeSync(BudgetPolicy, { onExcessProperty: "error" })(options) : undefined
  const usage = durableAtom({ input: Schema.Union([BudgetConfigured, BudgetUpdated, BudgetResolved, ToolCalled, ModelCalled, TurnSettled]), schema: ToolBudgetState, initial: { policy: null, used: 0, charged: [], granted: 0, decisions: [] }, reduce: toolBudgetState })
  const request = requests(AskBudget.request)
  return effectAtom(get => {
    const state = get(usage)
    if (!state.policy) return {
      view: { configured: false, used: state.used, limit: 0, remaining: 0, decision: null, request: null },
      acts: {}, events: initialPolicy ? { budget: eventValue({ type: "BudgetConfigured", policy: initialPolicy } satisfies Event) } : {},
    }
    const policy = state.policy
    const { pending, running } = get(pendingTools)
    const limit = policy.maxCalls + state.granted
    if (!Number.isSafeInteger(limit)) throw new RuntimeError("Tool budget exceeds safe integer range")
    const remaining = Math.max(0, limit - state.used)
    const base = { exhausted: remaining === 0 && policy.onExhausted === "deny", ...(policy.requestTool ? { requestTool: policy.requestTool } : {}), configured: true, used: state.used, limit, remaining }
    const resolution = state.decisions.find(value => value.callId === pending?.callId)?.decision
    if (pending && pending.name === policy.requestTool) {
      const waiting = { ...base, decision: null, request: { callId: pending.callId, reason: "Waiting for budget decision" } }
      if (resolution) return { view: { ...base, decision: null, request: null, response: resolution }, events: {}, acts: {} }
      if (remaining > 0) return { view: { ...base, decision: null, request: null, response: { error: "Tool budget is not exhausted" } }, events: {}, acts: {} }
      let input: typeof BudgetRequestInput.Type
      try { input = Schema.decodeUnknownSync(BudgetRequestInput, { onExcessProperty: "error" })(pending.input) }
      catch (error) { return { view: { ...base, decision: null, request: null, response: { error: String(error) } }, events: {}, acts: {} } }
      return {
        view: waiting,
        events: {}, acts: { budget: request({
          tag: pending.callId,
          input: { callId: pending.callId, ...input, used: state.used, limit },
          onSettled: result => {
            const decision = result.status === "fulfilled" ? result.value : { allowed: false as const, reason: `Budget request failed: ${result.reason}` }
            if (decision.allowed && !Number.isSafeInteger(limit + decision.additionalCalls)) return [{ type: "BudgetResolved", callId: pending.callId, decision: { allowed: false, reason: "Total tool budget exceeds safe integer range" } } satisfies Event]
            return [{ type: "BudgetResolved", callId: pending.callId, decision } satisfies Event]
          },
        }) },
      }
    }
    if (resolution && !resolution.allowed) return { view: { ...base, decision: resolution, request: null }, events: {}, acts: {} }
    if (base.exhausted) return { view: { ...base, decision: { allowed: false, reason: `Tool budget exhausted: ${state.used}/${limit} calls` }, request: null }, events: {}, acts: {} }
    if (!pending || running || remaining > 0) return { view: { ...base, decision: { allowed: true, reason: "Tool budget available" }, request: null }, events: {}, acts: {} }
    return { view: { ...base, decision: null, request: { callId: pending.callId, reason: `Tool budget exhausted: ${state.used}/${limit} calls` } }, events: {}, acts: {} }
  })
}

// budgetInstructions describes the current tool allowance and its exhaustion behavior for model input.
export const budgetInstructions = <R>(budget: Atom<ToolBudgetView<R>>) => atom(get => {
  const view = get(budget).view
  if (!view.configured) return ""
  const exhausted = view.remaining > 0 ? ""
    : view.exhausted ? " Answer without tools."
    : view.requestTool ? ` Request additional calls with ${view.requestTool}.`
    : " Further tool execution is waiting for additional budget."
  return `Tool calls remaining: ${view.remaining}/${view.limit}.${exhausted}`
})
