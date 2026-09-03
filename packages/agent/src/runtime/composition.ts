import type { Transition } from "@clavia/tardigrade-core/runtime"
import type { TransitionProjection } from "@clavia/tardigrade-core/transition"
import {
  composeComponents,
  deriveComponent,
  handles,
  inheritComponentContract,
  component,
  type Component,
  type ComponentRequirements,
  type ViewAlgebra
} from "@clavia/tardigrade-core/actor"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/log"
import { messageKeys } from "@clavia/tardigrade-core/communication/message"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ToolSpec } from "../inference/request"
import { fallbackOf, type OutputFallback } from "../output/contract"
import { agentKeys } from "../log/events"
import type { InferPolicy } from "../inference/contract"
import { inferenceMachine } from "../inference/machine"
import { modelPolicyOverrideOf, type ModelPolicyOverride } from "../inference/access"
import { incrementalToolsComponentFrom, type Answer, type PendingCall } from "./tools"
import type { ContextPolicy } from "../component/compaction"
import type { AgentR } from "./turn"
import { agentMessageMethod } from "../actor/message"

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

// NativeOutputFragment selects provider-native structured output without a fallback.
export interface NativeOutputFragment {
  readonly component: string
  readonly kind: "native"
}

// FallbackOutputFragment selects provider-native structured output with a fallback for calls the
// provider cannot serve natively (src/output/contract.ts, OutputFallback).
export interface FallbackOutputFragment {
  readonly component: string
  readonly kind: "fallback"
  readonly fallback: OutputFallback
  // The prompt this fallback needs when it runs. It reaches the model only on an attempt whose
  // mode is this fallback, so a native attempt reads exactly what it would read with nothing
  // mounted (request.ts, OutputRequest; platform/model/src/model.ts).
  readonly system?: string
}

export type OutputFragment = NativeOutputFragment | FallbackOutputFragment

// AgentView is the view the infer root interprets. Arrays retain component order and
// postpone collision policy until the complete component output is available.
export interface AgentView {
  readonly system: ReadonlyArray<string>
  readonly tools: ReadonlyArray<AgentTool<unknown>>
  readonly context: ReadonlyArray<ContextFragment>
  readonly output: ReadonlyArray<OutputFragment>
}

// AgentComponent is a core component whose view is interpreted by its infer root.
export type AgentComponent<R = never> = Component<AgentView, R>

const OutputFallbackMarker: unique symbol = Symbol("agent/OutputFallbackComponent")

// OutputFallbackComponent marks a component whose fallback strategy is present for every rendered turn.
export type OutputFallbackComponent<R = never> = AgentComponent<R> & { readonly [OutputFallbackMarker]: true }

// defineOutputFallback validates and marks a component that always contributes one fallback.
export const defineOutputFallback = <R>(component: AgentComponent<R>): OutputFallbackComponent<R> => {
  const output = (state: unknown) => {
    const derived = component.machine.output(state)
    const output = derived.view.output
    if (output.length !== 1 || output[0]?.kind !== "fallback" || fallbackOf(output[0].fallback) === undefined) {
      throw new Error(`output fallback component ${component.name} must declare one applicable fallback for every log`)
    }
    return derived
  }
  output(component.machine.initial())
  return { ...component, machine: { ...component.machine, output }, [OutputFallbackMarker]: true }
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

// outputFrom resolves the output strategy the assembly declares. A turn has one final response,
// so an absent or second declaration is an assembly error.
const outputFrom = (fragments: ReadonlyArray<OutputFragment>): OutputFragment => {
  const first = fragments[0]
  if (first === undefined) throw new Error("agent assembly must declare one output strategy")
  const second = fragments[1]
  if (second !== undefined) {
    throw new Error(`output strategy declared by components ${first.component} and ${second.component}`)
  }
  if (first.kind === "native") return first
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

const viewFrom = <const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>>(
  components: Cs,
  log: ReadonlyArray<Event>
): AgentView =>
  deriveComponent(composeComponents("agent.view", AGENT_VIEW_ALGEBRA, components), log).view

// Rendered is what one component output offers the model: the prompt, the tool table, the truncation
// policy, and the fallback for a declared output contract native output cannot serve. `output` is
// absent when the assembly selects native output.
export interface Rendered {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  readonly context: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

const renderView = (view: AgentView): Rendered => {
  const fragment = outputFrom(view.output)
  return {
    system: view.system.filter((piece) => piece !== "").join("\n"),
    tools: checkedTools(view.tools).map((tool) => tool.spec),
    context: contextOf(view.context),
    ...(fragment.kind === "native"
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
export const renderOf = <const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>>(
  components: Cs,
  log: ReadonlyArray<Event>
): Rendered =>
  renderView(viewFrom(components, log))

const rootKeys = (children: KeyFragment | undefined): KeyFragment => {
  const fragments = [messageKeys, agentKeys, ...(children === undefined ? [] : [children])]
  return {
    prefixes: fragments.flatMap((fragment) => fragment.prefixes),
    keyOf: composeKeys(...fragments)
  }
}

// InferOptions declares model authority and retry policy for an infer root.
export interface InferOptions extends Partial<Omit<InferPolicy, "models">> {
  readonly models?: ModelPolicyOverride
}

// infer composes an agent's child components and adds the model loop over their final view.
// Inference and dispatch derive from the same child projection, so a tool remains routed against
// the view that offered it while every child transition remains part of the root output.
export const infer = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options: InferOptions = {}
): AgentComponent<AgentR | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = AgentR | ComponentR
  const combined = composeComponents("infer.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<ComponentR>
  const childMachine = combined.machine
  renderView(childMachine.output(childMachine.initial()).view)
  const { models: rawModels, ...policy } = options
  const models = modelPolicyOverrideOf(rawModels)
  const inferPolicy = { ...policy, models }
  const incrementalInference = inferenceMachine(inferPolicy, {
    initial: childMachine.initial,
    step: childMachine.step,
    output: (state) => renderView(childMachine.output(state).view)
  }) as TransitionProjection<unknown, R>
  const incrementalTools = incrementalToolsComponentFrom(
    AGENT_VIEW_ALGEBRA.empty,
    childMachine,
    (view) => checkedTools(view.tools) as ReadonlyArray<AgentTool<R>>
  )
  const toolsMachine = incrementalTools.machine
  const root = component({
    name: "infer",
    keys: rootKeys(combined.keys),
    initial: () => ({
      children: childMachine.initial(),
      inference: incrementalInference.initial(),
      tools: toolsMachine.initial()
    }),
    step: (state, event) => ({
      children: childMachine.step(state.children, event),
      inference: incrementalInference.step(state.inference, event),
      tools: toolsMachine.step(state.tools, event)
    }),
    cancelState: (state, cancellation) => [
      ...(childMachine.cancel?.(state.children, cancellation) ?? []),
      ...(toolsMachine.cancel?.(state.tools, cancellation) ?? [])
    ],
    output: (state) => {
      const children = childMachine.output(state.children)
      const inferred = incrementalInference.output(state.inference)
      const resolvingModel = inferred.some((transition) => transition.key.startsWith("mr:"))
      return {
        view: children.view,
        transitions: resolvingModel ? inferred : [
          ...inferred,
          ...toolsMachine.output(state.tools).transitions,
          ...children.transitions
        ]
      }
    }
  }) as AgentComponent<R>
  return handles(agentMessageMethod, inheritComponentContract(root, combined))
}
