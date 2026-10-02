import { Context } from "effect"
import { type ModelRef } from "@clavia/tardigrade-model/reference"
import { type ToolSpec, type LibraryContract } from "@clavia/tardigrade-libraries/types"

// ModelInfo supplies resolved model metadata to actor construction.
export class ModelInfo extends Context.Service<ModelInfo, {
  readonly model: ModelRef
  readonly contextWindowTokens: number
}>()("experimental/agent/ModelInfo") {}

// ToolCatalog supplies descriptions and accepted names without executable handlers.
export class ToolCatalog extends Context.Service<ToolCatalog, {
  readonly specs: readonly ToolSpec[]
  readonly names: readonly string[]
  readonly libraries?: readonly LibraryContract[]
}>()("experimental/agent/ToolCatalog") {}

// actorContext selects the data services available during agent construction.
export const actorContext = Context.pick(ModelInfo, ToolCatalog)
