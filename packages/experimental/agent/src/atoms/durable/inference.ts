import { Schema } from "effect"
import { durableAtom, CoreEvent } from "@clavia/tardigrade-experimental-core"
import { MessageReceived, ModelCalled, ModelFailed, ModelReturned, ToolReturned, TurnSettled, AbortReceived } from "../../event"
import { InferenceState, inferState, initialInference } from "../../projections"

export const inferenceState = durableAtom({
  name: "agent.inference.state",
  input: Schema.Union([MessageReceived, ModelCalled, ModelFailed, ModelReturned, ToolReturned, TurnSettled, AbortReceived, CoreEvent]),
  schema: InferenceState,
  initial: initialInference,
  reduce: inferState,
})
