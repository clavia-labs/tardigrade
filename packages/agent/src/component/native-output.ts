import { NativeOutputSupport } from "../model/contract"
import type { AgentComponent } from "./view"
import { component } from "@clavia/tardigrade-core/actor"

// nativeOutput selects provider-native structured output and carries its model-layer requirement into the host type.
export const nativeOutput: AgentComponent<NativeOutputSupport> = component({
  name: "output.native",
  initial: () => undefined,
  step: (state: undefined) => state,
  output: () => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [{ component: "output.native", kind: "native" }]
    },
    transitions: []
  })
})
