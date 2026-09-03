import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Machine } from "@clavia/tardigrade-core/machine"
import { component, legacyComponent } from "@clavia/tardigrade-core/actor"
import type { AgentComponent } from "../runtime/composition"

export type SystemText = string | ((log: ReadonlyArray<Event>) => string)

// SystemProjection declares the event machine that produces log-dependent instructions.
export type SystemProjection<State> = Machine<Event, State, string>

// system contributes instructions derived from the current log.
export const system = <State = never>(text: SystemText | SystemProjection<State>): AgentComponent => {
  const derive = (value: string) => ({
    view: {
      system: [value],
      tools: [],
      context: [],
      output: []
    },
    transitions: []
  })
  if (typeof text === "object") {
    return component({
      name: "system",
      initial: text.initial,
      step: text.step,
      output: (state) => derive(text.output(state))
    })
  }
  return typeof text === "function"
    ? legacyComponent({ name: "system", derive: (log) => derive(text(log)) })
    : component({
        name: "system",
        initial: () => text,
        step: (state: string) => state,
        output: derive
      })
}
