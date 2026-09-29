import { Schema } from "effect"
import { ExecutionHandle } from "./effects"

// ExecutionResult distinguishes an immediate value from a handle to an eventual result.
export const ExecutionResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("value"), value: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("promise"), handle: ExecutionHandle }),
])
export type ExecutionResult = typeof ExecutionResult.Type
