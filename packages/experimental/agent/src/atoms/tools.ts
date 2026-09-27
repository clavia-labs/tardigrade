import { settledProjection } from "./settled-projection"
import { RuntimeError, type EffectExecution } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom, effectValue, type EffectValue, type EffectValues } from "@clavia/tardigrade-experimental-core"
import { ToolPromise, packageTools as packageMethods, type Package, type PackageRequirements } from "@clavia/tardigrade-experimental-packages"
import type { Event, ToolCall } from "../event"
import { ToolState, toolState, type PermissionState } from "../projections"
import { toolPromises } from "./promises"
import type { ToolBudgetView } from "./budget"
import type { Tool } from "../services/model"

export const pendingTools = settledProjection({ schema: ToolState, initial: { queue: [], pending: null, running: false }, reduce: toolState })

export type ToolPlan<R> =
  | { readonly position: "waiting" | "blocked"; readonly reason: string }
  | { readonly position: "ready"; readonly charged: boolean; readonly run: Effect.Effect<unknown, Error, R> }

export interface Tools<R = never> {
  readonly validate?: (event: Event) => void
  readonly effects: EffectValues<Event, Error, R>
  readonly specs: readonly Tool[]
  readonly prepare: (call: typeof ToolCall.Type) => ToolPlan<R>
}

// packageTools exposes package descriptions and lazy handlers with their required services.
export function packageTools<const P extends readonly Package<unknown>[]>(packages: P, additional: readonly Tool[] = []): Effect.Effect<Atom<Tools<PackageRequirements<P[number]>>>, never, Exclude<PackageRequirements<P[number]>, EffectExecution>> {
  type Services = PackageRequirements<P[number]>
  return Effect.map(Effect.context<Exclude<Services, EffectExecution>>(), () => {
    const methods = packageMethods(packages)
    const specs = [...methods.map(method => method.spec), ...additional]
    const registry = new Map(methods.map(method => [method.spec.name, method]))
    const names = new Set(specs.map(spec => spec.name))
    return atom(get => toolValue(get(pendingTools), {
      effects: { ...get(toolPromises).effects },
      specs,
      prepare: (call: typeof ToolCall.Type): ToolPlan<Services> => ({
        position: "ready",
        charged: names.has(call.name),
        run: Effect.suspend(() => {
          const method = registry.get(call.name)
          return method
            ? method.execute(call.input, call)
            : Effect.fail(new RuntimeError(`Unknown tool: ${call.name}`))
        }),
      }),
    })).pipe(NativeAtom.withLabel("tools"))
  })
}

// withPermissions waits for a decision and denies execution without charging a call.
export function withPermissions<R, P>(tools: Atom<Tools<R>>, permissions: Atom<typeof PermissionState.Type & { readonly effect?: EffectValue<Event, Error, P> }>): Atom<Tools<R | P>> {
  return atom(get => {
    const inner = get(tools)
    const state = get(permissions)
    return toolValue<R | P>(get(pendingTools), {
      validate: event => inner.validate?.(event),
      effects: { ...inner.effects, ...(state.effect ? { permission: state.effect } : {}) },
      specs: inner.specs,
      prepare: call => {
        const plan = inner.prepare(call)
        if (plan.position !== "ready" || !plan.charged) return plan
        const decision = state.decisions.findLast(value => value.callId === call.callId)?.decision
        if (!decision) return { position: "waiting", reason: "Waiting for tool permission" }
        return decision.allowed ? plan : { position: "ready", charged: false, run: Effect.fail(new RuntimeError(decision.reason)) }
      },
    })
  })
}

// withBudget preserves inner denials and authorizes calls whose reservation is recorded before execution.
export function withBudget<R, B>(tools: Atom<Tools<R>>, budget: Atom<ToolBudgetView<B>>, options: { readonly exempt?: readonly string[] } = {}): Atom<Tools<R | B>> {
  return atom(get => {
    const inner = get(tools)
    const allowance = get(budget)
    const requestTool = allowance.requestTool
    const pending = get(pendingTools).pending
    const candidate = pending ? inner.prepare(pending) : null
    const authorized = candidate?.position === "ready" && candidate.charged
    return toolValue<R | B>(get(pendingTools), {
      validate: event => {
        inner.validate?.(event)
        if (event.type === "BudgetResolved" && allowance.request?.callId !== event.callId) throw new RuntimeError("No matching pending budget request")
      },
      effects: { ...inner.effects, ...((!allowance.configured || authorized) && allowance.effect ? { budget: allowance.effect } : {}) },
      specs: requestTool && allowance.remaining === 0 ? inner.specs.filter(tool => tool.name === requestTool) : inner.specs,
      prepare: call => {
        const plan = inner.prepare(call)
        if (plan.position !== "ready" || !plan.charged) return plan
        if (call.name === requestTool) {
          if (!allowance.response) return { position: "waiting", reason: "Waiting for budget decision" }
          return {
            position: "ready", charged: false,
            run: "error" in allowance.response
              ? Effect.fail(new RuntimeError(allowance.response.error))
              : Effect.succeed(allowance.response),
          }
        }
        if (requestTool && allowance.remaining === 0 && call.name !== requestTool) return {
          position: "ready", charged: false,
          run: Effect.fail(new RuntimeError(`Tool budget exhausted. Only ${requestTool} is available.`)),
        }
        if (options.exempt?.includes(call.name)) return { ...plan, charged: false }
        const decision = allowance.decision
        if (!decision) return { position: "blocked", reason: allowance.request?.reason ?? "Waiting for tool budget" }
        return decision.allowed ? plan : { position: "ready", charged: false, run: Effect.fail(new RuntimeError(decision.reason)) }
      },
    })
  })
}

// toolValue replaces the inner execution proposal with the final governed plan.
function toolValue<R>(state: typeof ToolState.Type, tools: Tools<R>): Tools<R> {
  const { execution: _execution, ...effects } = tools.effects
  const call = state.pending
  if (!call || state.running) return { ...tools, effects }
  const plan = tools.prepare(call)
  if (plan.position !== "ready") return { ...tools, effects }
  return {
    ...tools,
    effects: {
      ...effects,
      execution: effectValue({
        id: call.callId,
        request: { type: "ToolCalled" as const, callId: call.callId, charged: plan.charged },
        run: plan.run.pipe(
          Effect.map(result => ({ type: "ToolReturned" as const, callId: call.callId, output: JSON.stringify(result) ?? "null", error: null, ...(Schema.is(ToolPromise)(result) ? { promise: result } : {}) })),
          Effect.catch(error => Effect.succeed({ type: "ToolReturned" as const, callId: call.callId, output: "", error: error.message })),
        ),
      }),
    },
  }
}
