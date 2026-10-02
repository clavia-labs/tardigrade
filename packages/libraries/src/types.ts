import { EffectRef, ExecutionHandle } from "@clavia/tardigrade-core"
import { Schema } from "effect"

export type LibraryFetch = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

export const DEFAULT_METHOD_EXECUTION = "foreground" as const

export const ExecutionMode = Schema.Literals(["foreground", "background"])
export type ExecutionMode = typeof ExecutionMode.Type
export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Json })
export type ToolCall = typeof ToolCall.Type
export const MethodAnnotations = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
})
export type MethodAnnotations = typeof MethodAnnotations.Type
export interface LibraryContract {
  readonly name: string
  readonly description: string
  readonly specs: readonly (ToolSpec & { readonly method: string })[]
}
export type LibrarySource = LibraryContract | { readonly library: LibraryContract }

export const ToolSpec = Schema.Struct({ name: Schema.String, description: Schema.String, inputSchema: Schema.Json, outputSchema: Schema.optionalKey(Schema.Json), annotations: Schema.optionalKey(MethodAnnotations), execution: Schema.optionalKey(ExecutionMode), promiseTimeoutMs: Schema.optionalKey(Schema.Int) })
export type ToolSpec = typeof ToolSpec.Type

export const ToolPromise = Schema.Struct({ type: Schema.Literal("promise"), ref: EffectRef, handle: ExecutionHandle })
export type ToolPromise = typeof ToolPromise.Type
