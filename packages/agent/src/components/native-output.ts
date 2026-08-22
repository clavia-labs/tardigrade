import { NativeOutputSupport } from "../runtime/infer"
import type { AgentComponent } from "../runtime/agent"

// nativeOutput selects provider-native structured output and carries its model-layer requirement into the host type.
export const nativeOutput: AgentComponent<NativeOutputSupport> = {
  name: "output.native",
  derive: () => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [{ component: "output.native", kind: "native" }]
    },
    transitions: []
  })
}
