import { ToolError } from "./errors"
import { EffectExecution, ExecutionHandle, type ExecutionResult, durablePromise } from "@clavia/tardigrade-core"
import { Cause, Effect, Exit, Schema } from "effect"
import type { ToolCall, ToolSpec, ExecutionMode, ToolMetadata } from "./types"

export interface ToolInvocation extends ToolCall {
  readonly parentCallId?: string
}

export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly aliases?: readonly string[]
  readonly execute: (input: unknown, call: ToolInvocation) => Effect.Effect<ExecutionResult, Error, R>
  readonly cancel?: (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<R, EffectExecution>>
}

export const DEFAULT_TOOL_EXECUTION = "sync" as const

interface ToolOptions<Input, R> {
  readonly name: string
  readonly description: string
  readonly metadata?: typeof ToolMetadata.Type
  readonly input: Schema.ConstraintDecoder<Input>
  readonly run: (input: Input, call: ToolInvocation) => Effect.Effect<unknown, Error, R>
}

// tool executes its handler in the mode declared by its definition.
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: "sync" }): AgentTool<R>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution: "async" }): AgentTool<R | EffectExecution>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: ExecutionMode }): AgentTool<R | EffectExecution> {
  const execution = options.execution ?? DEFAULT_TOOL_EXECUTION
  return {
    spec: { name: options.name, description: options.description, inputSchema: Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(options.input, { onExcessProperty: "error" }).schema), ...(options.metadata ? { metadata: options.metadata } : {}), execution },
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input).pipe(Effect.mapError(ToolError.from))
      if (execution === "sync") {
        const result = yield* options.run(value, call).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.mapError(ToolError.from))
        return { type: "value" as const, value: result }
      }
      const current = yield* EffectExecution
      const promise = durablePromise(current.ref, { success: Schema.Json, error: Schema.String })
      const handle = yield* current.fork(options.run(value, call).pipe(
        Effect.flatMap(result => Schema.decodeUnknownEffect(Schema.Json)(result)),
        Effect.exit,
        Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause))),
      ))
      return { type: "promise" as const, handle }
    }),
  }
}

// promiseTool exposes an executor's submitted handle without forking another local operation.
export function promiseTool<Input, R>(options: {
  readonly name: string
  readonly description: string
  readonly metadata?: typeof ToolMetadata.Type
  readonly input: Schema.ConstraintDecoder<Input>
  readonly submit: (input: Input, call: ToolInvocation) => Effect.Effect<ExecutionHandle, Error, R>
  readonly cancel?: (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<R, EffectExecution>>
}): AgentTool<R | EffectExecution> {
  return {
    spec: { name: options.name, description: options.description, inputSchema: Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(options.input, { onExcessProperty: "error" }).schema), ...(options.metadata ? { metadata: options.metadata } : {}), execution: "async" },
    ...(options.cancel ? { cancel: options.cancel } : {}),
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input)
      const current = yield* EffectExecution
      const handle = yield* current.submit(options.submit(value, call).pipe(Effect.flatMap(Schema.decodeEffect(ExecutionHandle)), Effect.mapError(ToolError.from)))
      return { type: "promise" as const, handle }
    }).pipe(Effect.mapError(ToolError.from)),
  }
}
