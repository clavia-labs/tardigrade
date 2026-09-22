import { component } from "@clavia/tardigrade-core/actor"
import { transcriptProjection } from "../projection/transcript"
import type { ContextPolicy } from "./compact/context"
import { AGENT_VIEW_ALGEBRA, type AgentComponent } from "./view"

export interface MessagesOptions {
  readonly name?: string
  readonly context?: Partial<ContextPolicy>
}

// messages projects committed events into the conversation view without proposing work.
export const messages = (options: MessagesOptions = {}): AgentComponent<never> => {
  const projection = transcriptProjection()
  const name = options.name ?? "messages"
  return component({
    name,
    initial: () => projection.initial(),
    step: projection.step,
    output: (state) => ({
      view: { ...AGENT_VIEW_ALGEBRA.empty, messages: [{
        component: name,
        trajectory: projection.output(state).events,
        context: options.context ?? {},
        ready: true
      }] },
      transitions: []
    })
  })
}
