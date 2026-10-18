import { durableAtom, tree, RuntimeError } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ModelConfiguration, ModelConfigured, ModelUpdated } from "../../contracts/events"

// modelState retains logged model configuration across replay and checkpoints (packages/platform/test/bun/agent-compaction.test.ts).
export const modelState = durableAtom({
  name: "agent.model", input: Schema.Union([ModelConfigured, ModelUpdated]),
  schema: tree(Schema.NullOr(ModelConfiguration)), initial: null,
  reduce: (document, event) => {
    const state = document.read([])
    if (event.type === "ModelConfigured" && state) throw new RuntimeError("Model is already configured")
    if (event.type === "ModelUpdated" && !state) throw new RuntimeError("Model is not configured")
    return document.set([], { model: event.model, contextWindowTokens: event.contextWindowTokens })
  },
})
