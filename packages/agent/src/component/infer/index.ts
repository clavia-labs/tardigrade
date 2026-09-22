import { checkedTools, renderView } from "./view"
export type { Rendered } from "./view"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { messages } from "../messages"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentView } from "../view"
import { turnViewFrom } from "@clavia/tardigrade-code/execution/turn-projection"
import { usageIn } from "../../model/usage"
export { AGENT_VIEW_ALGEBRA, type AgentView, type AgentComponent, type AgentTool, type ContextFragment, type NativeOutputFragment, type FallbackOutputFragment, type OutputFragment } from "../view"
import { composeComponents, handles, component as defineComponent, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/log"
import { messageKeys } from "@clavia/tardigrade-core/interaction/provider-message"
import { fallbackOf } from "../../output/contract"
import { agentKeys } from "../../log/events"
import type { InferPolicy } from "./contract"
import { inferenceMachine, type InferRejection } from "./machine"
export type { InferRejection } from "./machine"
import { modelPolicyOverrideOf, type ModelPolicyOverride } from "../../model/access"
import { routeTools, toolConcurrencyOf, type ToolConcurrency } from "../tool/machine"
import type { AgentR } from "../../runtime/turn"
import { agentMessageMethod } from "../../actor/message"

const OutputFallbackMarker: unique symbol = Symbol("agent/OutputFallbackComponent")

// OutputFallbackComponent marks a component whose fallback strategy is present for every rendered turn.
export type OutputFallbackComponent<R = never> = AgentComponent<R> & { readonly [OutputFallbackMarker]: true }

// defineOutputFallback validates and marks a component that always contributes one fallback.
export const defineOutputFallback = <R>(component: AgentComponent<R>): OutputFallbackComponent<R> => {
  const wrapped = defineComponent({
    name: `${component.name}.fallback`,
    children: component,
    initial: () => undefined,
    step: state => state,

    output: (_state, child) => {
    const derived = child.output();
    const output = derived.view.output;
    if (output.length !== 1 || output[0]?.kind !== "fallback" || fallbackOf(output[0].fallback) === undefined) {
        throw new Error(`output fallback component ${component.name} must declare one applicable fallback for every log`);
    }
    return derived;
}
  })
  return { ...component, ...wrapped, [OutputFallbackMarker]: true }
}

const rootKeys = (children: KeyFragment | undefined): KeyFragment => {
  const fragments = [messageKeys, agentKeys, ...(children === undefined ? [] : [children])]
  return {
    prefixes: fragments.flatMap((fragment) => fragment.prefixes),
    keyOf: composeKeys(...fragments)
  }
}

// InferOptions declares model authority, retry policy, and tool admission for an infer root.
export interface InferOptions extends Partial<Omit<InferPolicy, "models">> {
  readonly models?: ModelPolicyOverride
  readonly toolConcurrency?: ToolConcurrency
}

// InferView exposes independent completed-attempt costs for the current turn (infer.test.ts).
export interface InferView extends AgentView {
  readonly reportedCostUsd: number | undefined
  readonly estimatedCostUsd: number | undefined
}

// infer composes an agent's child components and adds the model loop over their final view.
// Inference and dispatch derive from the same child projection, so a tool remains routed against
// the view that offered it while every child transition remains part of the root output.
export const infer = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options: InferOptions = {}
): AgentComponent<AgentR | ComponentRequirements<Cs[number]>, InferView, InferRejection> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = AgentR | ComponentR
  const combined = composeComponents("infer.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<ComponentR>
  const { models: rawModels, toolConcurrency, ...policy } = options
  toolConcurrencyOf(toolConcurrency)
  const routing = routeTools(combined,
    (view) => checkedTools(view.tools).map(({ spec, concurrency }) => ({ spec, ...(concurrency === undefined ? {} : { concurrency }) })),
    toolConcurrency)
  const inference = inferenceMachine({ ...policy, models: modelPolicyOverrideOf(rawModels) })
  const root = defineComponent({
    children: [routing, messages({ name: "infer.messages" })] as const,
    name: "infer",
    dependencies: [ModelLock] as const,
    initial: (_children, [lock]) => inference.initial(lock),
    step: inference.step,

    output: (state, [child, fallback]) => {
      const children = child.output()
      const inferred = inference.output(state, {
        rendered: renderView(children.view, toolConcurrency, fallback.output().view.messages?.[0], children.transitions)
      })
      const compactions = new Set(children.view.messages?.flatMap(conversation => conversation.compaction?.proposals ?? []) ?? [])
      const proposals = children.transitions.filter((transition) => !compactions.has(transition.key))
      const turn = turnViewFrom(state.turns)
      const usage = usageIn(turn, String(turn[0]?.id ?? ""))
      const empty = !turn.some(event => event.usage !== undefined || event.legacyUsage !== undefined)
      return {
        view: {
          ...children.view,
          reportedCostUsd: empty ? 0 : usage.reportedCostUsd,
          estimatedCostUsd: empty ? 0 : usage.estimatedCostUsd
        },
        // Component intents commit policy decisions before inference or tool admission (batches.test.ts, "generated starting allowances are recorded once before inference and survive restart").
        transitions: [
          ...proposals.filter((transition) => transition.kind === "intent"),
          ...inferred,
          ...proposals.filter((transition) => transition.kind !== "intent")
        ],
        interactions: {
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  }) as AgentComponent<R, InferView, InferRejection>
  return handles(agentMessageMethod, { ...root, keys: rootKeys(combined.keys) })
}
