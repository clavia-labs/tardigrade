import type { Event } from "@clavia/tardigrade-core/event"
import type { AgentComponent } from "../runtime/agent"

export type SystemText = string | ((log: ReadonlyArray<Event>) => string)

// system contributes instructions derived from the current log.
export const system = (text: SystemText): AgentComponent => ({
  name: "system",
  derive: (log) => ({
    view: {
      system: [typeof text === "function" ? text(log) : text],
      tools: [],
      context: [],
      output: []
    },
    transitions: []
  })
})
