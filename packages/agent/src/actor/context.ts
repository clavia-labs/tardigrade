import { Context } from "effect"
import type { LibraryRpc, toolkitFromRpc } from "@clavia/tardigrade-libraries"
import { type ModelRef } from "@clavia/tardigrade-model/reference"
import { type ToolSpec, type LibraryContract } from "@clavia/tardigrade-libraries/types"

// ModelInfo supplies initial model metadata; logged configuration controls subsequent calls (packages/platform/test/bun/agent-compaction.test.ts).
export class ModelInfo extends Context.Service<ModelInfo, {
  readonly model: ModelRef
  readonly contextWindowTokens: number
}>()("experimental/agent/ModelInfo") {}

// ToolCatalog supplies descriptions and accepted names without executable handlers.
export class ToolCatalog extends Context.Service<ToolCatalog, {
  readonly specs: readonly ToolSpec[]
  readonly names: readonly string[]
  readonly libraries?: readonly LibraryContract[]
  readonly nativeTools?: ReturnType<typeof toolkitFromRpc<LibraryRpc>>["tools"]
}>()("experimental/agent/ToolCatalog") {}

// actorContext selects the data services available during agent construction.
export const actorContext = Context.pick(ModelInfo, ToolCatalog)
