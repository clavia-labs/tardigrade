import { ToolError } from "./errors"
import { EffectExecution, ExecutionHandle, type ExecutionResult, durablePromise } from "@clavia/tardigrade-core"
import { jsonSchemaOf } from "@clavia/tardigrade-core/json-schema"
import { Cause, Effect, Exit, Schema } from "effect"
import { DEFAULT_METHOD_EXECUTION, type ToolCall, type ToolSpec, type ExecutionMode, type MethodAnnotations } from "./types"

export interface ToolInvocation extends ToolCall {
  readonly parentCallId?: string
}

export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly aliases?: readonly string[]
  readonly execute: (input: unknown, call: ToolInvocation) => Effect.Effect<ExecutionResult, Error, R>
  readonly cancel?: (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<R, EffectExecution>>
}

interface ToolOptions<Input, R> {
  readonly name: string
  readonly description: string
  readonly annotations?: MethodAnnotations
  readonly promiseTimeoutMs?: number
  readonly input: Schema.ConstraintDecoder<Input>
  readonly run: (input: Input, call: ToolInvocation) => Effect.Effect<unknown, Error, R>
}

// tool executes its handler in the mode declared by its definition.
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: "foreground" }): AgentTool<R>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution: "background" }): AgentTool<R | EffectExecution>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: ExecutionMode }): AgentTool<R | EffectExecution>
export function tool<Input, R>(options: ToolOptions<Input, R> & { readonly execution?: ExecutionMode }): AgentTool<R | EffectExecution> {
  const execution = options.execution ?? DEFAULT_METHOD_EXECUTION
  validatePromiseTimeout(options.promiseTimeoutMs, execution)
  return {
    spec: { name: options.name, description: options.description, inputSchema: jsonSchemaOf(options.input, { onExcessProperty: "error" }), ...(options.annotations ? { annotations: options.annotations } : {}), execution, ...(options.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: options.promiseTimeoutMs }) },
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input).pipe(Effect.mapError(ToolError.from))
      if (execution === "foreground") {
        const result = yield* options.run(value, call).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.mapError(ToolError.from))
        return { type: "value" as const, value: result }
      }
      const current = yield* EffectExecution
      const promise = durablePromise(current.ref, { success: Schema.Json, error: Schema.String })
      const handle = yield* current.fork(options.run(value, call).pipe(
        Effect.flatMap(result => Schema.decodeUnknownEffect(Schema.Json)(result)),
        Effect.exit,
        Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause))),
      ), { timeoutMs: options.promiseTimeoutMs })
      return { type: "promise" as const, handle }
    }),
  }
}

// promiseTool exposes an executor's submitted handle without forking another local operation.
export function promiseTool<Input, R>(options: {
  readonly name: string
  readonly description: string
  readonly annotations?: MethodAnnotations
  readonly promiseTimeoutMs?: number
  readonly input: Schema.ConstraintDecoder<Input>
  readonly submit: (input: Input, call: ToolInvocation) => Effect.Effect<ExecutionHandle, Error, R>
  readonly cancel?: (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<R, EffectExecution>>
}): AgentTool<R | EffectExecution> {
  validatePromiseTimeout(options.promiseTimeoutMs, "background")
  return {
    spec: { name: options.name, description: options.description, inputSchema: jsonSchemaOf(options.input, { onExcessProperty: "error" }), ...(options.annotations ? { annotations: options.annotations } : {}), execution: "background", ...(options.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: options.promiseTimeoutMs }) },
    ...(options.cancel ? { cancel: options.cancel } : {}),
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input)
      const current = yield* EffectExecution
      const handle = yield* current.submit(options.submit(value, call).pipe(Effect.flatMap(Schema.decodeEffect(ExecutionHandle)), Effect.mapError(ToolError.from)), { timeoutMs: options.promiseTimeoutMs })
      return { type: "promise" as const, handle }
    }).pipe(Effect.mapError(ToolError.from)),
  }
}

// validatePromiseTimeout rejects unusable waiting budgets before a method runs.
function validatePromiseTimeout(timeoutMs: number | undefined, execution: ExecutionMode) {
  if (timeoutMs === undefined) return
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("promiseTimeoutMs must be a positive safe integer")
  if (execution !== "background") throw new Error("promiseTimeoutMs requires background execution")
}
