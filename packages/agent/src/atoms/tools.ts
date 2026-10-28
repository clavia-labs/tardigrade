import { pendingTools, ToolState } from "./durable/tools"
import { ExecuteTool, requests, failureMessage } from "../contracts/acts"
import { RuntimeError, effectAtom, eventValue, type Atom, type ActRequest, type ActorOutput } from "@clavia/tardigrade-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { ToolCalled, ToolReturned, toolReturnedOutput, BudgetResolved, type Event, ToolCall } from "../contracts/events"
import { type PermissionState } from "./durable/permissions"
import { toolPromises } from "./tool-promises"
import { type ToolBudgetView } from "./budget-request"
import { type ToolSpec, type LibrarySource } from "@clavia/tardigrade-libraries/types"
import { selectLibraries } from "../contracts/libraries"
import { ToolCatalog } from "../actor/context"

export type ToolPlan =
  | { readonly position: "waiting" | "blocked"; readonly reason: string }
  | { readonly position: "ready"; readonly counted: boolean; readonly value?: Schema.Json; readonly error?: string }

// An undefined group is an exclusive fence. Limits are explicit and checked at admission.
export interface ToolExecutionPolicy {
  readonly concurrency: number
  readonly group?: (call: typeof ToolCall.Type) => { readonly key: string; readonly limit: number } | undefined
}
export interface ToolExecutionAdapter {
  readonly output?: (value: Schema.Json, counted: boolean) => ReturnType<typeof toolReturnedOutput>
}
export interface ToolView<R = never> {
  readonly execution?: ToolExecutionPolicy | undefined
  readonly specs: readonly ToolSpec[]
  readonly request: (input: Parameters<typeof ExecuteTool.request>[0]) => ActRequest<Schema.Json, string, R>
  readonly prepare: (call: typeof ToolCall.Type) => ToolPlan
}

export type Tools<R = never> = ActorOutput<ToolView<R>, Event, R>

// invalidArguments answers a call whose provider arguments were not a JSON object, which a provider passes on as their
// raw text, so the model can resend the call instead of the whole turn failing and repeating.
const invalidArguments = (raw: string) => {
  try {
    JSON.parse(raw)
    return "Tool arguments must be a JSON object. Resend the call with the arguments as a JSON object."
  } catch (error) {
    return `Tool arguments were not valid JSON (${error instanceof Error ? error.message : String(error)}). Resend the call with the arguments as a JSON object.`
  }
}

// tools constructs tool proposals from the configured library catalog.
export function tools(sources?: readonly LibrarySource[]) {
  return Effect.map(ToolCatalog, catalog => {
    const libraries = sources ? selectLibraries(sources, catalog.libraries ?? []) : undefined
    const selected = libraries ? new Set(libraries.flatMap(library => library.specs.map(spec => spec.name))) : undefined
    const specs = selected ? catalog.specs.filter(spec => selected.has(spec.name)) : catalog.specs
    const names = libraries ? libraries.flatMap(library => library.specs.flatMap(spec => [spec.name, `${library.name}__${spec.method}`])) : catalog.names
    const cached = requests(ExecuteTool.request)
    // A governed concurrent proposal owns its callbacks. Historical sequential proposals
    // retain their cached request identity and delivery behavior.
    const request = (input: Parameters<typeof ExecuteTool.request>[0]) => input.concurrent ? ExecuteTool.request(input)
      : cached(JSON.stringify([input.input.call.callId, input.input]), input)
    return effectAtom(get => toolValue(get(pendingTools), {
      events: get(toolPromises).events, acts: {},
      view: {
        specs, request,
        prepare: (call: typeof ToolCall.Type): ToolPlan => !names.includes(call.name) ? { position: "ready", counted: false, error: `Unknown tool: ${call.name}` }
          : typeof call.input === "string" ? { position: "ready", counted: false, error: invalidArguments(call.input) } : { position: "ready", counted: true },
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
        execution: inner.view.execution,
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
        execution: inner.view.execution,
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
          if (inner.view.execution && allowance.remaining === 0 && decision?.allowed !== false) return { position: "blocked", reason: "Waiting for tool budget" }
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

// withToolExecution opts an actor into bounded foreground execution. Omit it to retain
// sequential scheduling and background promise delivery.
export function withToolExecution<R>(tools: Atom<Tools<R>>, policy: ToolExecutionPolicy): Atom<Tools<R>> {
  return effectAtom(get => {
    const inner = get(tools)
    return toolValue(get(pendingTools), {...inner, view: {...inner.view, execution: policy}})
  })
}

// toolValue replaces the inner execution proposal with the final governed plan.
export function toolValue<R>(state: typeof ToolState.Type, tools: Tools<R>, adapter?: ToolExecutionAdapter): Tools<R> {
  if (tools.view.execution) return concurrentToolValue(state, tools, tools.view.execution, adapter)
  const { execution: _execution, ...acts } = tools.acts
  const call = state.pending
  if (!call || state.running) return { ...tools, acts }
  const turnId = state.queue.find(item => item.call.callId === call.callId)?.turnId
  const owner = { ...(turnId === undefined ? {} : { turnId }), tool: { name: call.name, providerId: call.providerId } }
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
          return [{ type: "ToolReturned", ...owner, callId: call.callId, ...toolReturnedOutput(promise), error: null, promise } satisfies ToolReturned]
        },
        onSettled: (result, _ref, handle) => handle ? [] : [result.status === "fulfilled"
          ? { type: "ToolReturned", ...owner, callId: call.callId, ...toolReturnedOutput(result.value), error: null } satisfies ToolReturned
          : { type: "ToolReturned", ...owner, version: 1, callId: call.callId, content: [], error: failureMessage(result.reason) } satisfies ToolReturned],
      }),
    },
  }
}


// Opt-in scheduling still uses native effect admission, cancellation and recovery. ToolCalled
// reserves spend before admitting the next call. Its journal position gives each effect a
// distinct origin; a completed result is journaled before ordered ToolReturned delivery.
function concurrentToolValue<R>(state: typeof ToolState.Type, inner: Tools<R>, policy: ToolExecutionPolicy, adapter?: ToolExecutionAdapter): Tools<R> {
  const {toolAdmission: _admission, toolResult: _result, ...events} = inner.events
  const tools = {...inner, events}
  if (!Number.isSafeInteger(policy.concurrency) || policy.concurrency < 1) throw new RuntimeError("Tool concurrency must be a positive safe integer")
  const acts = Object.fromEntries(Object.entries(tools.acts).filter(([key]) => key !== "execution" && !key.startsWith("tool.execution:"))) as Tools<R>["acts"]
  const head = state.queue[0]
  if (!head) return {...tools, acts}
  if (head.result) return {...tools, acts, events: {...tools.events, toolResult: eventValue(head.result)}}
  const batch = state.queue.filter(item => item.batch === head.batch)
  const active = batch.filter(item => item.running && !item.result)
  const group = (call: typeof ToolCall.Type) => {
    const value = policy.group ? policy.group(call) : {key: "default", limit: policy.concurrency}
    if (value && (!Number.isSafeInteger(value.limit) || value.limit < 1)) throw new RuntimeError("Tool group limit must be a positive safe integer")
    return value
  }
  let admission: ToolCalled | undefined
  // Bound retained out-of-order results as well as running effects.
  for (const [index, item] of batch.slice(0, policy.concurrency).entries()) {
    if (item.running || item.result) continue
    const prior = batch.slice(0, index).filter(value => !value.result)
    const lane = group(item.call)
    if (active.length >= policy.concurrency || prior.some(value => !group(value.call)) || (!lane && prior.length > 0)) break
    if (lane && active.filter(value => group(value.call)?.key === lane.key).length >= lane.limit) continue
    const plan = tools.view.prepare(item.call)
    if (plan.position !== "ready") break
    admission = {type: "ToolCalled", callId: item.call.callId, counted: plan.counted, admitted: {
      ...(plan.value === undefined ? {} : {value: plan.value}), ...(plan.error === undefined ? {} : {error: plan.error}),
    }}
    break
  }
  const execution: Record<string, Tools<R>["acts"][string]> = {...acts}
  for (const item of active) {
    if (!item.plan || item.origin === undefined) throw new RuntimeError("Concurrent call has no durable admission")
    const call = item.call, plan = item.plan
    const owner = {...(item.turnId === undefined ? {} : {turnId: item.turnId}), tool: {name: call.name, providerId: call.providerId}}
    execution[`tool.execution:${call.callId}`] = tools.view.request({
      concurrent: true, origin: item.origin,
      input: {call, ...plan},
      onRequested: () => [],
      onDeferred: () => [],
      onSettled: result => [{type: "ToolCompleted", result: result.status === "fulfilled"
        ? {type: "ToolReturned", ...owner, callId: call.callId, ...(adapter?.output ?? toolReturnedOutput)(result.value, plan.counted), error: null}
        : {type: "ToolReturned", ...owner, version: 1, callId: call.callId, content: [], error: failureMessage(result.reason)}} satisfies Event],
    })
  }
  return {...tools, acts: execution, events: {...tools.events, ...(admission ? {toolAdmission: eventValue(admission)} : {})}}
}
