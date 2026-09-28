import { settledProjection } from "./settled-projection"
import { EffectExecution, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { atom, effectAtom, type Atom, eventValue, type EffectOutput } from "@clavia/tardigrade-experimental-core"
import { ToolBudgetState, toolBudgetState, type ToolState } from "../projections"
import { requestPromises } from "./requests"
import { BudgetRequests, requestResult } from "../services/requests"
import { BudgetConfigured, BudgetUpdated, BudgetResolved, ToolCalled, ModelCalled, TurnSettled, BudgetPolicy, BudgetDecision, type Event } from "../event"
import { BudgetRequestInput } from "../budget-tools"

export type ToolBudgetView<R = never> = EffectOutput<{
  readonly requestTool?: string
  readonly exhausted?: boolean
  readonly configured: boolean
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly decision: { readonly allowed: boolean; readonly reason: string } | null
  readonly request: { readonly callId: string; readonly reason: string } | null
  readonly response?: typeof BudgetDecision.Type | { readonly error: string }
}, Event, Error, R>

export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number }): Atom<ToolBudgetView>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool: string }): Atom<ToolBudgetView<BudgetRequests | EffectExecution>>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly configure: false }): Atom<ToolBudgetView>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool?: string } | { readonly configure: false }): Atom<ToolBudgetView<BudgetRequests | EffectExecution>> {
  if ("maxCalls" in options && (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0)) throw new RuntimeError("maxCalls must be a nonnegative safe integer")
  const initialPolicy = "maxCalls" in options ? Schema.decodeSync(BudgetPolicy, { onExcessProperty: "error" })(options) : undefined
  const usage = settledProjection({ input: Schema.Union([BudgetConfigured, BudgetUpdated, BudgetResolved, ToolCalled, ModelCalled, TurnSettled]), schema: ToolBudgetState, initial: { policy: null, used: 0, charged: [], granted: 0, decisions: [] }, reduce: toolBudgetState })
  return effectAtom(get => {
    const state = get(usage)
    if (!state.policy) return {
      view: { configured: false, used: state.used, limit: 0, remaining: 0, decision: null, request: null },
      effects: initialPolicy ? { budget: eventValue({ id: "configure", event: { type: "BudgetConfigured", policy: initialPolicy } satisfies Event }) } : {},
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
      if (resolution) return { view: { ...base, decision: null, request: null, response: resolution }, effects: {} }
      if (get(requestPromises).some(item => item.type === "BudgetResolved" && item.callId === pending.callId)) return { view: waiting, effects: {} }
      if (remaining > 0) return { view: { ...base, decision: null, request: null, response: { error: "Tool budget is not exhausted" } }, effects: {} }
      let input: typeof BudgetRequestInput.Type
      try { input = Schema.decodeUnknownSync(BudgetRequestInput, { onExcessProperty: "error" })(pending.input) }
      catch (error) { return { view: { ...base, decision: null, request: null, response: { error: String(error) } }, effects: {} } }
      return {
        view: waiting,
        effects: { budget: {
          kind: "effect" as const,
          id: pending.callId,
          run: Effect.gen(function* () {
            const service = yield* BudgetRequests
            const answer = yield* service.request({ callId: pending.callId, ...input, used: state.used, limit })
            const result = yield* Schema.decodeEffect(requestResult(BudgetDecision))(answer).pipe(Effect.mapError(RuntimeError.from))
            if (result.type === "decision") {
              if (result.decision.allowed && !Number.isSafeInteger(limit + result.decision.additionalCalls)) return yield* Effect.fail(new RuntimeError("Total tool budget exceeds safe integer range"))
              return { type: "BudgetResolved", callId: pending.callId, decision: result.decision } as const
            }
            const execution = yield* EffectExecution
            return { type: "BudgetResolved", callId: pending.callId, promise: { ref: execution.ref, handle: result.handle, ...(result.mode ? { mode: result.mode } : {}) } } as const
          }).pipe(
            Effect.catch(error => Effect.succeed({ type: "BudgetResolved" as const, callId: pending.callId, decision: { allowed: false as const, reason: `Budget request failed: ${error.message}` } })),
          ),
        } },
      }
    }
    if (resolution && !resolution.allowed) return { view: { ...base, decision: resolution, request: null }, effects: {} }
    if (base.exhausted) return { view: { ...base, decision: { allowed: false, reason: `Tool budget exhausted: ${state.used}/${limit} calls` }, request: null }, effects: {} }
    if (!pending || running || remaining > 0) return { view: { ...base, decision: { allowed: true, reason: "Tool budget available" }, request: null }, effects: {} }
    return { view: { ...base, decision: null, request: { callId: pending.callId, reason: `Tool budget exhausted: ${state.used}/${limit} calls` } }, effects: {} }
  })
}

// budgetInstructions describes the current tool allowance and its exhaustion behavior for model input.
export const budgetInstructions = <R>(budget: Atom<ToolBudgetView<R>>) => atom(get => {
  const view = get(budget).view
  if (!view.configured) return ""
  const exhausted = view.remaining > 0 ? ""
    : view.requestTool ? ` Request additional calls with ${view.requestTool}.`
    : view.exhausted ? " Answer without tools."
    : " Further tool execution is waiting for additional budget."
  return `Tool calls remaining: ${view.remaining}/${view.limit}.${exhausted}`
})
