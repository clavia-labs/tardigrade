import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ToolSpec } from "../../model/request"
import { fallbackOf, type OutputFallback } from "../../output/contract"
import type { AgentView, MessageView, AgentTool, ContextFragment, OutputFragment } from "../view"
import type { ContextPolicy } from "../compact/index"
import { toolConcurrencyOf, toolConcurrencyInstruction, DEFAULT_TOOL_CONCURRENCY, type ToolConcurrency } from "../tool/machine"

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

export const checkedTools = (tools: ReadonlyArray<AgentTool>): ReadonlyArray<AgentTool> => {
  const names = new Set<string>()
  for (const tool of tools) {
    toolConcurrencyOf(tool.concurrency)
    if (names.has(tool.spec.name)) throw new Error(`tool "${tool.spec.name}" declared more than once`)
    names.add(tool.spec.name)
  }
  return tools
}

// Rendered is what one component output offers the model: the prompt, the tool table, the truncation
// policy, and the fallback for a declared output contract native output cannot serve. `output` is
// absent when the assembly selects native output.
export interface Rendered<R = never> {
  readonly compactionTransitions?: ReadonlyArray<Transition<never, R>>
  readonly conversation?: MessageView
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  readonly context: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

export const renderView = <R = never>(view: AgentView, concurrency: ToolConcurrency = DEFAULT_TOOL_CONCURRENCY, fallback?: MessageView, transitions: ReadonlyArray<Transition<never, R>> = []): Rendered<R> => {
  const fragment = outputFrom(view.output)
  const conversation = view.messages?.[0] ?? fallback
  if ((view.messages?.length ?? 0) > 1) throw new Error("messages declared by multiple components")
  return {
    system: [...view.system, toolConcurrencyInstruction(toolConcurrencyOf(concurrency))].filter((piece) => piece !== "").join("\n"),
    tools: checkedTools(view.tools).map((tool) => {
      const instruction = toolConcurrencyInstruction(toolConcurrencyOf(tool.concurrency))
      return instruction === "" ? tool.spec : { ...tool.spec, description: `${tool.spec.description}\n${instruction}` }
    }),
    context: contextOf([...view.context, ...(conversation === undefined ? [] : [{ component: conversation.component, policy: conversation.context }])]),
    ...(conversation === undefined ? {} : { conversation }),
    compactionTransitions: transitions.filter(transition => conversation?.compaction?.proposals.includes(transition.key)),
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
