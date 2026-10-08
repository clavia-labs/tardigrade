import { pendingTools, ToolState } from "./durable/tools"
import { ExecuteTool, requests, failureMessage } from "../contracts/acts"
import { RuntimeError, effectAtom, type Atom, type ActRequest, type ActorOutput } from "@clavia/tardigrade-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/reactivity"
import { ToolCalled, ToolReturned, BudgetResolved, type Event, ToolCall } from "../contracts/events"
import { type PermissionState } from "./durable/permissions"
import { toolPromises } from "./tool-promises"
import { type ToolBudgetView } from "./budget-request"
import { type ToolSpec, type LibrarySource } from "@clavia/tardigrade-libraries/types"
import { selectLibraries } from "../contracts/libraries"
import { ToolCatalog } from "../actor/context"

export type ToolPlan =
  | { readonly position: "waiting" | "blocked"; readonly reason: string }
  | { readonly position: "ready"; readonly counted: boolean; readonly value?: Schema.Json; readonly error?: string }

export interface ToolView<R = never> {
  readonly specs: readonly ToolSpec[]
  readonly request: (input: Parameters<typeof ExecuteTool.request>[0]) => ActRequest<Schema.Json, string, R>
  readonly prepare: (call: typeof ToolCall.Type) => ToolPlan
}

export type Tools<R = never> = ActorOutput<ToolView<R>, Event, R>

// tools constructs tool proposals from the configured library catalog.
export function tools(sources?: readonly LibrarySource[]) {
  return Effect.map(ToolCatalog, catalog => {
    const libraries = sources ? selectLibraries(sources, catalog.libraries ?? []) : undefined
    const selected = libraries ? new Set(libraries.flatMap(library => library.specs.map(spec => spec.name))) : undefined
    const specs = selected ? catalog.specs.filter(spec => selected.has(spec.name)) : catalog.specs
    const names = libraries ? libraries.flatMap(library => library.specs.flatMap(spec => [spec.name, `${library.name}__${spec.method}`])) : catalog.names
    const cached = requests(ExecuteTool.request)
    const request = (input: Parameters<typeof ExecuteTool.request>[0]) => cached(JSON.stringify([input.input.call.callId, input.input]), input)
    return effectAtom(get => toolValue(get(pendingTools), {
      events: get(toolPromises).events, acts: {},
      view: {
        specs, request,
        prepare: (call: typeof ToolCall.Type): ToolPlan => names.includes(call.name) ? { position: "ready", counted: true } : { position: "ready", counted: false, error: `Unknown tool: ${call.name}` },
      },
    })).pipe(NativeAtom.withLabel("tools"))
  })
}

// withPermissions waits for a decision and denies execution without counting a call.
export function withPermissions<R, P>(tools: Atom<Tools<R>>, permissions: Atom<ActorOutput<typeof PermissionState.Type, Event, P>>): Atom<Tools<R | P>> {
  return effectAtom(get => {
    const inner = get(tools)
    const permission = get(permissions)
    const state = permission.view
    return toolValue<R | P>(get(pendingTools), {
      events: { ...inner.events, ...permission.events },
      acts: { ...inner.acts, ...permission.acts },
      view: {
        request: inner.view.request,
        specs: inner.view.specs,
        prepare: call => {
          const plan = inner.view.prepare(call)
          if (plan.position !== "ready" || !plan.counted) return plan
          const decision = state.decisions.findLast(value => value.action === "tool.execute" && value.requestId === call.callId)?.decision
          if (!decision) return { position: "waiting", reason: "Waiting for tool permission" }
          return decision.allowed ? plan : { position: "ready", counted: false, error: decision.reason }
        },
      },
    })
  })
}

// withBudget preserves inner denials and authorizes calls whose reservation is recorded before execution.
export function withBudget<R, B>(tools: Atom<Tools<R>>, budget: Atom<ToolBudgetView<B>>, options: { readonly exempt?: readonly string[] } = {}): Atom<Tools<R | B>> {
  return effectAtom(get => {
    const inner = get(tools)
    const budgetOutput = get(budget)
    const allowance = budgetOutput.view
    if (!allowance.configured) return {
      ...inner, events: { ...inner.events, ...budgetOutput.events }, acts: { ...inner.acts, ...budgetOutput.acts },
    }
    const requestTool = allowance.requestTool
    const pending = get(pendingTools).pending
    const candidate = pending ? inner.view.prepare(pending) : null
    const authorized = candidate?.position === "ready" && candidate.counted
    return toolValue<R | B>(get(pendingTools), {
      events: { ...inner.events, ...(authorized ? budgetOutput.events : {  })
},
      acts: { ...inner.acts, ...(authorized ? budgetOutput.acts : {  })
},
      view: {
        request: inner.view.request,
        specs: allowance.exhausted ? [] : requestTool && allowance.remaining === 0 ? inner.view.specs.filter(tool => tool.name === requestTool) : inner.view.specs,
        prepare: call => {
          const plan = inner.view.prepare(call)
          if (plan.position !== "ready" || !plan.counted) return plan
          if (call.name === requestTool) {
            if (!allowance.response) return { position: "waiting", reason: "Waiting for budget decision" }
            return {
              position: "ready", counted: false,
              ...("error" in allowance.response ? { error: allowance.response.error } : { value: allowance.response }),
            }
          }
          if (requestTool && allowance.remaining === 0 && call.name !== requestTool) return {
            position: "ready", counted: false,
            error: `Tool budget exhausted. Only ${requestTool} is available.`,
          }
          if (options.exempt?.includes(call.name)) return { ...plan, counted: false }
          const decision = allowance.decision
          if (!decision) return { position: "blocked", reason: allowance.request?.reason ?? "Waiting for tool budget" }
          return decision.allowed ? plan : { position: "ready", counted: false, error: decision.reason }
        },
      },
    })
  }, {
    input: BudgetResolved,
    validate: (event, get) => {
      const allowance = get(budget).view
      if (allowance.configured && event.metric === "toolCalls" && allowance.request?.callId !== event.callId) throw new RuntimeError("No matching pending budget request")
    },
  })
}

// toolValue replaces the inner execution proposal with the final governed plan.
function toolValue<R>(state: typeof ToolState.Type, tools: Tools<R>): Tools<R> {
  const { execution: _execution, ...acts } = tools.acts
  const call = state.pending
  if (!call || state.running) return { ...tools, acts }
  const plan = tools.view.prepare(call)
  if (plan.position !== "ready") return { ...tools, acts }
  return {
    ...tools,
    acts: {
      ...acts,
      execution: tools.view.request({
        ...(state.origin === null ? {} : { origin: state.origin }),
        input: { call, counted: plan.counted, ...(plan.value !== undefined ? { value: plan.value } : {}), ...(plan.error !== undefined ? { error: plan.error } : {  })
},
        onRequested: () => [{ type: "ToolCalled", callId: call.callId, counted: plan.counted } satisfies ToolCalled],
        onDeferred: (handle, ref) => {
          const promise = { type: "promise" as const, ref, handle }
          return [{ type: "ToolReturned", callId: call.callId, output: JSON.stringify(promise), error: null, promise } satisfies ToolReturned]
        },
        onSettled: (result, _ref, handle) => handle ? [] : [result.status === "fulfilled"
          ? { type: "ToolReturned", callId: call.callId, output: JSON.stringify(result.value), error: null } satisfies ToolReturned
          : { type: "ToolReturned", callId: call.callId, output: "", error: failureMessage(result.reason) } satisfies ToolReturned],
      }),
    },
  }
}
