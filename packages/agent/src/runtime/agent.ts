import type { Actor, Reactor, Transition } from "@clavia/tardigrade-core/actor"
import {
  actorOf,
  composeComponents,
  type Component,
  type ComponentRequirements,
  type ComponentRuntime,
  type ViewAlgebra
} from "@clavia/tardigrade-core/component"
import { messageKeys } from "@clavia/tardigrade-core/message"
import type { Event } from "@clavia/tardigrade-core/event"
import type { ToolSpec } from "../request"
import { fallbackOf, type OutputFallback } from "../output"
import { agentKeys } from "../events"
import { inferReactorFor, type InferPolicy, type NativeOutputSupport } from "./infer"
import { toolsReactorFrom, type Answer, type PendingCall } from "./tools"
import type { ContextPolicy } from "../components/compaction"
import type { AgentR } from "../turn"

// AgentTool pairs one model-visible tool specification with the handler for calls to that tool.
// A derived tool is therefore advertised and routable from the same value.
export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly serve: (
    call: PendingCall,
    log: ReadonlyArray<Event>,
    answer: Answer
  ) => ReadonlyArray<Transition<never, R>>
}

// ContextFragment names one component's context policy contribution. contextOf rejects
// conflicting fields, so composition cannot hide a policy override.
export interface ContextFragment {
  readonly component: string
  readonly policy: Partial<ContextPolicy>
}

// OutputFragment names one component's output fallback contribution: what a turn does when
// native structured output is unavailable for the call. An assembly that mounts none has no
// fallback, so such a turn fails before it spends; two that disagree throw, because a turn has
// one final response and one way to fall back (src/output.ts, OutputFallback).
export interface OutputFragment {
  readonly component: string
  readonly fallback: OutputFallback
  // The prompt this fallback needs when it runs. It reaches the model only on an attempt whose
  // mode is this fallback, so a native attempt reads exactly what it would read with nothing
  // mounted (request.ts, OutputRequest; platform/model/src/model.ts).
  readonly system?: string
}

// AgentView is the view an agent runtime interprets. Arrays retain component order and
// postpone collision policy until the complete derivation is available.
export interface AgentView {
  readonly system: ReadonlyArray<string>
  readonly tools: ReadonlyArray<AgentTool<unknown>>
  readonly context: ReadonlyArray<ContextFragment>
  readonly output: ReadonlyArray<OutputFragment>
}

// AgentComponent is a core component whose view is interpreted by the agent runtime.
export type AgentComponent<R = never> = Component<AgentView, R>

const OutputFallbackMarker: unique symbol = Symbol("agent/OutputFallbackComponent")

// OutputFallbackComponent marks a component whose fallback is present for every rendered turn. agentOf uses the marker to remove the NativeOutputSupport requirement.
export type OutputFallbackComponent<R = never> = AgentComponent<R> & { readonly [OutputFallbackMarker]: true }

// defineOutputFallback validates and marks a component that always contributes one fallback.
export const defineOutputFallback = <R>(component: AgentComponent<R>): OutputFallbackComponent<R> => {
  const derive: AgentComponent<R>["derive"] = (log) => {
    const derived = component.derive(log)
    const output = derived.view.output
    if (output.length !== 1 || fallbackOf(output[0]?.fallback) === undefined) {
      throw new Error(`output fallback component ${component.name} must declare one applicable fallback for every log`)
    }
    return derived
  }
  derive([])
  return { ...component, derive, [OutputFallbackMarker]: true }
}

// AGENT_VIEW_ALGEBRA preserves every view contribution in component order. renderOf
// applies the agent-specific collision and rendering rules to the combined value.
export const AGENT_VIEW_ALGEBRA: ViewAlgebra<AgentView> = {
  empty: { system: [], tools: [], context: [], output: [] },
  combine: (left, right) => ({
    system: [...left.system, ...right.system],
    tools: [...left.tools, ...right.tools],
    context: [...left.context, ...right.context],
    output: [...left.output, ...right.output]
  })
}

// fallbackFrom resolves the one output fallback the assembly declares. A turn has one final
// response, so a second declaration is an assembly error even when the two agree: a reader of the
// mount list must be able to name the fallback from it.
const fallbackFrom = (fragments: ReadonlyArray<OutputFragment>): OutputFragment | undefined => {
  const first = fragments[0]
  if (first === undefined) return undefined
  const second = fragments[1]
  if (second !== undefined) {
    throw new Error(`output fallback declared by components ${first.component} and ${second.component}`)
  }
  const fallback = fallbackOf(first.fallback)
  if (fallback === undefined) {
    throw new Error(
      `output fallback declared by component ${first.component} is not applicable: ${JSON.stringify(first.fallback)}`
    )
  }
  return { ...first, fallback }
}

const contextOf = (fragments: ReadonlyArray<ContextFragment>): Partial<ContextPolicy> => {
  const context: Partial<Record<keyof ContextPolicy, number>> = {}
  const owners = new Map<keyof ContextPolicy, string>()
  for (const fragment of fragments) {
    for (const [field, value] of Object.entries(fragment.policy) as Array<[keyof ContextPolicy, number]>) {
      const prior = context[field]
      if (prior !== undefined && prior !== value) {
        throw new Error(`context field "${field}" declared by components ${owners.get(field)} and ${fragment.component}`)
      }
      context[field] = value
      owners.set(field, fragment.component)
    }
  }
  return context
}

const checkedTools = (tools: ReadonlyArray<AgentTool<unknown>>): ReadonlyArray<AgentTool<unknown>> => {
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.spec.name)) throw new Error(`tool "${tool.spec.name}" declared more than once`)
    names.add(tool.spec.name)
  }
  return tools
}

const viewFrom = <R>(components: ReadonlyArray<AgentComponent<R>>, log: ReadonlyArray<Event>): AgentView =>
  composeComponents("agent.view", AGENT_VIEW_ALGEBRA, components).derive(log).view

// offerLogFor returns the prefix from which inference offered a pending call's tools. ModelCalled
// is appended before inference, so the preceding prefix is exactly the log passed to render
// (infer.ts, inferReactorFor; tla/Component.tla, OfferedIsRoutable). Calls created outside
// inference have no mark and use the current log.
const offerLogFor = (log: ReadonlyArray<Event>, call: PendingCall): ReadonlyArray<Event> => {
  const called = log.findIndex(
    (event) => event.type === "ToolCalled" && String((event as { callId?: unknown }).callId) === call.callId
  )
  if (called === -1) return log
  for (let index = called - 1; index >= 0; index--) {
    const event = log[index]!
    if (event.type !== "ModelCalled") continue
    const turn = (event as { turn?: unknown }).turn
    if (call.turn === undefined || turn === undefined || String(turn) === call.turn) return log.slice(0, index)
  }
  return log
}

// Rendered is what one derivation offers the model: the prompt, the tool table, the truncation
// policy, and the fallback for a declared output contract native output cannot serve. `output` is
// absent when the assembly declares no fallback.
export interface Rendered {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  readonly context: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

const renderView = (view: AgentView): Rendered => {
  const fragment = fallbackFrom(view.output)
  return {
    system: view.system.filter((piece) => piece !== "").join("\n"),
    tools: checkedTools(view.tools).map((tool) => tool.spec),
    context: contextOf(view.context),
    ...(fragment === undefined
      ? {}
      : {
          output: {
            fallback: fragment.fallback,
            ...(fragment.system === undefined || fragment.system === "" ? {} : { system: fragment.system })
          }
        })
  }
}

// renderOf derives the model request from the same component view that routing reads.
export const renderOf = <R>(components: ReadonlyArray<AgentComponent<R>>, log: ReadonlyArray<Event>): Rendered =>
  renderView(viewFrom(components, log))

// agentRuntime interprets AgentView as inference and tool-routing reactors. actorOf supplies the
// composed view projection and adds each component's own transition projection.
export const agentRuntime = (
  policy: Partial<InferPolicy> = {}
): ComponentRuntime<AgentView, AgentR | NativeOutputSupport> => ({
  name: "agent",
  algebra: AGENT_VIEW_ALGEBRA,
  keys: [messageKeys, agentKeys],
  reactors: <C>(viewOf: (log: ReadonlyArray<Event>) => AgentView): ReadonlyArray<Reactor<AgentR | C>> => {
    const toolsOf = (log: ReadonlyArray<Event>): ReadonlyArray<AgentTool<unknown>> => checkedTools(viewOf(log).tools)
    const offeredTools = (log: ReadonlyArray<Event>, call: PendingCall): ReadonlyArray<AgentTool<unknown>> =>
      toolsOf(offerLogFor(log, call))
    const serve = (call: PendingCall, log: ReadonlyArray<Event>, answer: Answer) => {
      const tool = offeredTools(log, call).find((candidate) => candidate.spec.name === call.name)
      return tool?.serve(call, log, answer) as ReadonlyArray<Transition<never, AgentR | C>> | undefined
    }

    renderView(viewOf([]))
    return [
      inferReactorFor(policy, (log) => renderView(viewOf(log))) as Reactor<AgentR | C>,
      toolsReactorFrom(serve, (log, call) => offeredTools(log, call).map((tool) => tool.spec))
    ]
  }
})

type OutputRequirement<Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>> = Extract<
  Cs[number],
  OutputFallbackComponent<unknown>
> extends never
  ? NativeOutputSupport
  : never

// agentOf assembles an agent and carries its output requirement into the host environment. An assembly without a marked fallback requires NativeOutputSupport from its model layer.
export const agentOf = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  policy: Partial<InferPolicy> = {}
): Actor<AgentR | ComponentRequirements<Cs[number]> | OutputRequirement<Cs>> =>
  actorOf(agentRuntime(policy), components) as Actor<
    AgentR | ComponentRequirements<Cs[number]> | OutputRequirement<Cs>
  >
