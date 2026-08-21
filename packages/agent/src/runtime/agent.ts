import type { Reactor, Transition } from "@clavia/tardigrade-core/actor"
import { composeComponents, type Component, type ComponentRuntime, type InfoAlgebra } from "@clavia/tardigrade-core/component"
import { messageKeys } from "@clavia/tardigrade-core/message"
import type { Event } from "@clavia/tardigrade-core/event"
import type { ToolSpec } from "../request"
import { agentKeys } from "../events"
import { inferReactorFor, type InferPolicy } from "./infer"
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

// AgentInfo is the information an agent runtime interprets. Arrays retain component order and
// postpone collision policy until the complete derivation is available.
export interface AgentInfo {
  readonly system: ReadonlyArray<string>
  readonly tools: ReadonlyArray<AgentTool<unknown>>
  readonly context: ReadonlyArray<ContextFragment>
}

// AgentComponent is a core component whose information is interpreted by the agent runtime.
export type AgentComponent<R = never> = Component<AgentInfo, R>

// AGENT_INFO_ALGEBRA preserves every information contribution in component order. renderOf
// applies the agent-specific collision and rendering rules to the combined value.
export const AGENT_INFO_ALGEBRA: InfoAlgebra<AgentInfo> = {
  empty: { system: [], tools: [], context: [] },
  combine: (left, right) => ({
    system: [...left.system, ...right.system],
    tools: [...left.tools, ...right.tools],
    context: [...left.context, ...right.context]
  })
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

const infoFrom = <R>(components: ReadonlyArray<AgentComponent<R>>, log: ReadonlyArray<Event>): AgentInfo =>
  composeComponents("agent.info", AGENT_INFO_ALGEBRA, components).derive(log).info

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

const renderInfo = (
  info: AgentInfo
): { readonly system: string; readonly tools: ReadonlyArray<ToolSpec>; readonly context: Partial<ContextPolicy> } => ({
  system: info.system.filter((fragment) => fragment !== "").join("\n"),
  tools: checkedTools(info.tools).map((tool) => tool.spec),
  context: contextOf(info.context)
})

// renderOf derives the model request from the same component information that routing reads.
export const renderOf = <R>(
  components: ReadonlyArray<AgentComponent<R>>,
  log: ReadonlyArray<Event>
): { readonly system: string; readonly tools: ReadonlyArray<ToolSpec>; readonly context: Partial<ContextPolicy> } =>
  renderInfo(infoFrom(components, log))

// agentRuntime interprets AgentInfo as inference and tool-routing reactors. actorOf supplies the
// composed information projection and adds each component's own transition projection.
export const agentRuntime = (
  policy: Partial<InferPolicy> = {}
): ComponentRuntime<AgentInfo, AgentR> => ({
  name: "agent",
  algebra: AGENT_INFO_ALGEBRA,
  keys: [messageKeys, agentKeys],
  reactors: <C>(infoOf: (log: ReadonlyArray<Event>) => AgentInfo): ReadonlyArray<Reactor<AgentR | C>> => {
    const toolsOf = (log: ReadonlyArray<Event>): ReadonlyArray<AgentTool<unknown>> => checkedTools(infoOf(log).tools)
    const offeredTools = (log: ReadonlyArray<Event>, call: PendingCall): ReadonlyArray<AgentTool<unknown>> =>
      toolsOf(offerLogFor(log, call))
    const serve = (call: PendingCall, log: ReadonlyArray<Event>, answer: Answer) => {
      const tool = offeredTools(log, call).find((candidate) => candidate.spec.name === call.name)
      return tool?.serve(call, log, answer) as ReadonlyArray<Transition<never, AgentR | C>> | undefined
    }

    renderInfo(infoOf([]))
    return [
      inferReactorFor(policy, (log) => renderInfo(infoOf(log))) as Reactor<AgentR | C>,
      toolsReactorFrom(serve, (log, call) => offeredTools(log, call).map((tool) => tool.spec))
    ]
  }
})
