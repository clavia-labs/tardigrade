import { RuntimeError, type ExecutionHandle } from "@clavia/tardigrade-experimental-core"
import { Context, Effect, JsonSchema, Layer, Schema, SchemaRepresentation } from "effect"
import { LanguageModel, Prompt, Tool as AiTool, Toolkit } from "effect/unstable/ai"
import { modelLayer, type ModelBindingOptions } from "@clavia/tardigrade-model/host"
import { BindingSettings, CurrentModel, ModelSelection } from "@clavia/tardigrade-model/settings"
import type { ModelRef } from "@clavia/tardigrade-model/reference"
import type { ToolSpec } from "@clavia/tardigrade-experimental-packages"
import { ModelLock } from "./model-lock"
import type { Conversation } from "../projections"
import type { ToolCall } from "../event"

export type Tool = ToolSpec
export interface ModelReply { readonly text: string; readonly toolCalls: readonly (typeof ToolCall.Type)[] }

export interface ModelInput { readonly model: ModelRef; readonly system: string; readonly tools: readonly Tool[]; readonly context: typeof Conversation.Type }

export class Model extends Context.Service<Model, {
  readonly call: (input: ModelInput) => Effect.Effect<ModelReply, Error>
  readonly submit?: (input: ModelInput) => Effect.Effect<ExecutionHandle, Error>
}>()("example/Model") {}

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000
export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

export interface ModelServiceOptions {
  readonly timeoutMs?: number
}

// modelServices adapts native AI providers to the agent's model service without executing tools.
export function modelServices(options: ModelServiceOptions = {}) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new RuntimeError("timeoutMs must be a positive safe integer")
  return Layer.effect(Model, Effect.gen(function* () {
    const lock = yield* ModelLock
    const languageModel = yield* LanguageModel.LanguageModel
    const selection = yield* ModelSelection
    const fallback = yield* BindingSettings
    return { call: input => Effect.gen(function* () {
      const resolved = lock.resolve(input.model)
      const settings = yield* (selection.settings?.(resolved.model) ?? Effect.succeed(fallback))
      const timeoutMs = options.timeoutMs ?? settings.policy.timeout.attemptMs ?? DEFAULT_MODEL_TIMEOUT_MS
      const toolkit = yield* Effect.try({
        try: () => Toolkit.make(...input.tools.map(tool => AiTool.dynamic(tool.name, {
          description: `${tool.description} Execution: ${tool.execution ?? "sync"}.`,
          parameters: Schema.Struct({ input: Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(tool.inputSchema)),
            settings.schemaImport ?? DEFAULT_SCHEMA_IMPORT_OPTIONS,
          )) }),
        }))),
        catch: RuntimeError.from,
      })
      const response = yield* languageModel.generateText({
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("system", { content: input.system }),
          ...input.context.map((message): Prompt.Message => {
            if (message.role === "user") return Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: message.text })] })
            if (message.role === "tool") return Prompt.makeMessage("tool", { content: [Prompt.makePart("tool-result", { id: message.callId, name: message.name, result: message.text, isFailure: message.error, providerExecuted: false })] })
            return Prompt.makeMessage("assistant", { content: [
              ...(message.text ? [Prompt.makePart("text", { text: message.text })] : []),
              ...message.toolCalls.map(call => Prompt.makePart("tool-call", { id: call.callId, name: call.name, params: { input: call.input }, providerExecuted: false })),
            ] })
          }),
        ]),
        toolkit,
        toolChoice: input.tools.length ? "auto" : "none",
        disableToolCallResolution: true,
      }).pipe(
        Effect.provideService(CurrentModel, resolved.model),
        Effect.timeout(timeoutMs),
        Effect.mapError(RuntimeError.from),
      )
      if (response.finishReason === "length") return yield* Effect.fail(new RuntimeError(`Model reached maxOutputTokens=${settings.policy.maxOutputTokens}`))
      const toolCalls: (typeof ToolCall.Type)[] = []
      for (const call of response.toolCalls) {
        if (typeof call.params !== "object" || call.params === null || !("input" in call.params)) return yield* Effect.fail(new RuntimeError(`Invalid tool arguments: ${call.name}`))
        toolCalls.push({ callId: call.id, name: call.name, input: call.params.input })
      }
      return { text: response.text, toolCalls }
    }) } satisfies typeof Model.Service
  }))
}

// liveModelServices connects the agent to Tardie's locked provider configuration and credentials.
export function liveModelServices(options: ModelBindingOptions & ModelServiceOptions) {
  const { timeoutMs, ...binding } = options
  return modelServices(timeoutMs === undefined ? {} : { timeoutMs }).pipe(Layer.provideMerge(modelLayer(binding)))
}
