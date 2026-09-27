import { Schema } from "effect"

export const ExecutionMode = Schema.Literals(["sync", "async"])
export type ExecutionMode = typeof ExecutionMode.Type
export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Unknown })
export type ToolCall = typeof ToolCall.Type
export const ToolMetadata = Schema.Struct({ readOnly: Schema.optionalKey(Schema.Boolean) })
export const ToolSpec = Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Unknown, metadata: Schema.optionalKey(ToolMetadata), execution: Schema.optionalKey(ExecutionMode) })
export type ToolSpec = typeof ToolSpec.Type
