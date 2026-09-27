import { EffectExecution, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { atom, type Atom, durableAtom, effectValue, eventValue, type EffectValue } from "@clavia/tardigrade-experimental-core"
import { ToolBudgetState, toolBudgetState, type ToolState } from "../projections"
import { requestPromises } from "./requests"
import { BudgetRequests, requestResult } from "../services/requests"
import { BudgetPolicy, BudgetDecision, type Event } from "../event"
import { BudgetRequestInput } from "../budget-tools"

export type ToolBudgetView<R = never> = {
  readonly requestTool?: string
  readonly configured: boolean
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly decision: { readonly allowed: boolean; readonly reason: string } | null
  readonly request: { readonly callId: string; readonly reason: string } | null
  readonly response?: typeof BudgetDecision.Type | { readonly error: string }
  readonly effect?: EffectValue<Event, Error, R>
}

export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number }): Atom<ToolBudgetView>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool: string }): Atom<ToolBudgetView<BudgetRequests | EffectExecution>>
export function toolBudget(pendingTools: Atom<typeof ToolState.Type>, options: { readonly maxCalls: number; readonly requestTool?: string }): Atom<ToolBudgetView<BudgetRequests | EffectExecution>> {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0) throw new RuntimeError("maxCalls must be a nonnegative safe integer")
  const initialPolicy = Schema.decodeSync(BudgetPolicy, { onExcessProperty: "error" })(options)
  const usage = durableAtom({ schema: ToolBudgetState, initial: { policy: null, used: 0, charged: [], granted: 0, requested: [], decisions: [] }, reduce: toolBudgetState })
  return atom(get => {
    const state = get(usage)
    if (!state.policy) return {
      configured: false, used: state.used, limit: 0, remaining: 0, decision: null, request: null,
      effect: eventValue({ id: "configure", event: { type: "BudgetConfigured", policy: initialPolicy } satisfies Event }),
    }
    const policy = state.policy
    const { pending, running } = get(pendingTools)
    const limit = policy.maxCalls + state.granted
    if (!Number.isSafeInteger(limit)) throw new RuntimeError("Tool budget exceeds safe integer range")
    const remaining = Math.max(0, limit - state.used)
    const base = { ...(policy.requestTool ? { requestTool: policy.requestTool } : {}), configured: true, used: state.used, limit, remaining }
    const resolution = state.decisions.find(value => value.callId === pending?.callId)?.decision
    if (pending && pending.name === policy.requestTool) {
      const waiting = { ...base, decision: null, request: { callId: pending.callId, reason: "Waiting for budget decision" } }
      if (resolution) return { ...base, decision: null, request: null, response: resolution }
      const submitted = get(requestPromises).find(item => item.type === "BudgetSubmitted" && item.callId === pending.callId)
      if (submitted) {
        if (submitted.result.status === "pending") return waiting
        let decision: typeof BudgetDecision.Type
        try {
          if (submitted.result.status === "rejected") throw new RuntimeError(submitted.result.error)
          decision = Schema.decodeUnknownSync(BudgetDecision)(submitted.result.value)
          if (decision.allowed && !Number.isSafeInteger(limit + decision.additionalCalls)) throw new RuntimeError("Total tool budget exceeds safe integer range")
        } catch (error) { decision = { allowed: false, reason: `Budget request failed: ${String(error)}` } }
        return { ...waiting, effect: eventValue({ id: `resolve:${pending.callId}`, event: { type: "BudgetResolved", callId: pending.callId, decision } satisfies Event }) }
      }
      if (remaining > 0) return { ...base, decision: null, request: null, response: { error: "Tool budget is not exhausted" } }
      let input: typeof BudgetRequestInput.Type
      try { input = Schema.decodeUnknownSync(BudgetRequestInput, { onExcessProperty: "error" })(pending.input) }
      catch (error) { return { ...base, decision: null, request: null, response: { error: String(error) } } }
      if (state.requested.includes(pending.callId)) return waiting
      return {
        ...waiting,
        effect: effectValue({
          id: pending.callId,
          request: { type: "BudgetRequested" as const, callId: pending.callId, ...input },
          run: Effect.gen(function* () {
            const service = yield* BudgetRequests
            const answer = yield* service.request({ callId: pending.callId, ...input, used: state.used, limit })
            const result = yield* Schema.decodeEffect(requestResult(BudgetDecision))(answer).pipe(Effect.mapError(RuntimeError.from))
            if (result.type === "decision") {
              if (result.decision.allowed && !Number.isSafeInteger(limit + result.decision.additionalCalls)) return yield* Effect.fail(new RuntimeError("Total tool budget exceeds safe integer range"))
              return { type: "BudgetResolved", callId: pending.callId, decision: result.decision } as const
            }
            const execution = yield* EffectExecution
            return { type: "BudgetSubmitted", callId: pending.callId, ref: execution.ref, handle: result.handle, ...(result.mode ? { mode: result.mode } : {}) } as const
          }).pipe(
            Effect.catch(error => Effect.succeed({ type: "BudgetResolved" as const, callId: pending.callId, decision: { allowed: false as const, reason: `Budget request failed: ${error.message}` } })),
          ),
        }),
      }
    }
    if (resolution && !resolution.allowed) return { ...base, decision: resolution, request: null }
    if (!pending || running || remaining > 0) return { ...base, decision: { allowed: true, reason: "Tool budget available" }, request: null }
    return { ...base, decision: null, request: { callId: pending.callId, reason: `Tool budget exhausted: ${state.used}/${limit} calls` } }
  })
}
