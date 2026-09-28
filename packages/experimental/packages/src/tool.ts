import { ToolError } from "./errors"
import { EffectExecution, EffectRef, ExecutionHandle, durablePromise } from "@clavia/tardigrade-experimental-core"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Context } from "effect"
import type { ToolCall, ToolSpec, ExecutionMode, ToolMetadata } from "./types"

export interface ToolInvocation extends ToolCall {
  readonly parentCallId?: string
}

export interface AgentTool<R = never> {
  readonly spec: ToolSpec
  readonly aliases?: readonly string[]
  readonly execute: (input: unknown, call: ToolInvocation) => Effect.Effect<unknown, Error, R>
}

export const ToolPromise = Schema.Struct({ type: Schema.Literal("promise"), ref: EffectRef, handle: ExecutionHandle })
export type ToolPromise = typeof ToolPromise.Type

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
    spec: { name: options.name, description: options.description, inputSchema: Schema.toJsonSchemaDocument(options.input, { onExcessProperty: "error" }).schema, ...(options.metadata ? { metadata: options.metadata } : {}), execution },
    execute: (input, call) => Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(options.input, { onExcessProperty: "error" })(input).pipe(Effect.mapError(ToolError.from))
      if (execution === "sync") return yield* options.run(value, call)
      const current = yield* EffectExecution
      const promise = durablePromise(current.ref, { success: Schema.Json, error: Schema.String })
      const handle = yield* current.fork(options.run(value, call).pipe(
        Effect.flatMap(result => Schema.decodeUnknownEffect(Schema.Json)(result)),
        Effect.exit,
        Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause))),
      ))
      return { type: "promise" as const, ref: promise.ref, handle }
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
}): AgentTool<R | EffectExecution> {
  const method = tool({ ...options, run: (input: Input, call: ToolInvocation) => Effect.gen(function* () {
    const current = yield* EffectExecution
    const handle = yield* options.submit(input, call)
    return { type: "promise" as const, ref: current.ref, handle }
  }) })
  return { ...method, spec: { ...method.spec, execution: "async" } }
}

// toolLayer captures tool services and routes calls by registered name.
export function toolLayer<R>(tools: readonly AgentTool<R>[]) {
  const entries = tools.flatMap(tool => [tool.spec.name, ...(tool.aliases ?? [])].map(name => [name, tool] as const))
  const registry = new Map(entries)
  if (registry.size !== entries.length) throw new ToolError("Duplicate tool name")
  return Layer.effect(ToolExecutor, Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    return {
      execute: (call: ToolCall) => {
        const handler = registry.get(call.name)
        return handler
          ? handler.execute(call.input, call).pipe(Effect.provide(context))
          : Effect.fail(new ToolError(`Unknown tool: ${call.name}`))
      },
    }
  }))
}

export class ToolExecutor extends Context.Service<ToolExecutor, {
  readonly execute: (call: ToolCall) => Effect.Effect<unknown, Error>
}>()("tardigrade/experimental/packages/ToolExecutor") {}
