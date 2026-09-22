import type { Context } from "effect"
import type { ModelLock } from "@clavia/tardigrade-model/lock"
import { machineOf } from "../../../core/src/component/runtime"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { composeComponents, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { AGENT_VIEW_ALGEBRA, type AgentComponent } from "../component/view"
import type { InferOptions } from "../component/infer"
import { renderView, type Rendered } from "../component/infer/view"

// renderOf derives the model request from the same component view that routing reads.
export const renderOf = <const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>>(
  components: Cs,
  log: ReadonlyArray<Event>,
  options: Pick<InferOptions, "toolConcurrency"> & { readonly data?: Context.Context<ModelLock> } = {}
): Rendered<ComponentRequirements<Cs[number]>> => {
  const output = replayProjection(machineOf(composeComponents("agent.view", AGENT_VIEW_ALGEBRA, components)), log, options.data)
  return renderView(output.view, options.toolConcurrency, undefined, output.transitions)
}
