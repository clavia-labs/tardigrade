import { durableAtom, RuntimeError } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ModelConfiguration, ModelConfigured, ModelUpdated } from "../../contracts/events"

// modelState retains logged model configuration across replay and checkpoints (packages/platform/test/bun/agent-compaction.test.ts).
export const modelState = durableAtom({
  name: "agent.model", input: Schema.Union([ModelConfigured, ModelUpdated]),
  schema: Schema.NullOr(ModelConfiguration), initial: null,
  reduce: (state, event) => {
    if (event.type === "ModelConfigured" && state) throw new RuntimeError("Model is already configured")
    if (event.type === "ModelUpdated" && !state) throw new RuntimeError("Model is not configured")
    return { model: event.model, contextWindowTokens: event.contextWindowTokens }
  },
})
