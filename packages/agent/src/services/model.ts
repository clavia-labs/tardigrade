import { modelRetry } from "./model-retry"
import type { RetryOptions } from "@clavia/tardigrade-core/services/effect-execution"
import { ModelInfo } from "../actor/context"
import { RuntimeError, type ExecutionHandle, type ActCancellation, durablePromise, EffectExecution } from "@clavia/tardigrade-core"
import { Effect, Layer, Context, JsonSchema, Schema, SchemaRepresentation, Cause, Exit, Option, Stream } from "effect"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { ObjectStorage, objectKeyOf } from "@clavia/tardigrade-model/object"
import { AiError, LanguageModel, Prompt, Tool as AiTool, Toolkit } from "effect/unstable/ai"
import { ResponseFormat } from "@tardie/ai"
import type { Content as ToolResultContent } from "@tardie/ai/ToolResult"
import { modelLayer, type ModelBindingOptions } from "@clavia/tardigrade-model/host"
import { reportedCostOf } from "@clavia/tardigrade-model/providers/usage"
import { BindingSettings, CurrentModel, ModelSelection } from "@clavia/tardigrade-model/settings"
import { type ModelRef } from "@clavia/tardigrade-model/reference"
import { DEFAULT_METHOD_EXECUTION, type ToolSpec } from "@clavia/tardigrade-libraries"
import { type Conversation, MessageContentPart, ModelReply as ModelReplySchema } from "../contracts/events"
import type { OutputContract } from "../contracts/acts"
import { Generate, Summarize } from "../contracts/acts"
import { collectModelStream, type ModelCallContext } from "./model-stream"

export { type ModelCallContext, type ModelDelta } from "./model-stream"

export { ModelLock }

// resolveModel acquires locked metadata when constructing an atom graph.
export const resolveModel = Effect.flatMap(ModelLock, lock => Effect.try({
  try: () => {
    const resolution = lock.resolve()
    const contextWindowTokens = resolution.contextWindowTokens
    if (contextWindowTokens === undefined || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
      throw new RuntimeError("ModelLock must provide a positive integer contextWindowTokens")
    }
    return { model: resolution.model, contextWindowTokens }
  },
  catch: RuntimeError.from,
}))

export const modelInfo = Layer.effect(ModelInfo, resolveModel)

export type Tool = ToolSpec
export type ModelReply = typeof ModelReplySchema.Type

export interface ModelInput { readonly model: ModelRef; readonly system: string; readonly tools: readonly Tool[]; readonly context: typeof Conversation.Type; readonly output?: OutputContract }

export class Model extends Context.Service<Model, {
  readonly call: (input: ModelInput, context?: ModelCallContext) => Effect.Effect<ModelReply, Error>
  readonly retry?: (input: ModelInput) => Effect.Effect<RetryOptions<Error>, Error>
  readonly promiseTimeoutMs?: number | ((input: ModelInput) => Effect.Effect<number, Error>)
  readonly submit?: (input: ModelInput, context: Pick<typeof EffectExecution.Service, "ref" | "signal" | "publish">) => Effect.Effect<ExecutionHandle, Error>
  readonly cancel?: (input: ModelInput, context: Omit<ActCancellation, "request">) => Effect.Effect<void, Error>
}>()("example/Model") {}

export const DEFAULT_MODEL_TIMEOUT_MS = 60_000
export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

export interface ModelServiceOptions {
  readonly timeoutMs?: number
  readonly promiseTimeoutMs?: number
}

const ProviderError = Schema.Struct({ error: Schema.Struct({
  message: Schema.String,
  metadata: Schema.optionalKey(Schema.Struct({ raw: Schema.optionalKey(Schema.String) })),
}) })

// modelError retains provider rejection details without copying HTTP request headers into persisted errors.
export function modelError(error: AiError.AiError): RuntimeError {
  const body = "http" in error.reason ? error.reason.http?.body : undefined
  if (!body) return RuntimeError.from(error)
  try {
    const parsed: unknown = JSON.parse(body)
    if (!Schema.is(ProviderError)(parsed)) return RuntimeError.from(error)
    const raw = parsed.error.metadata?.raw
    let detail = parsed.error.message
    if (raw) {
      try {
        const nested: unknown = JSON.parse(raw)
        detail = Schema.is(ProviderError)(nested) ? nested.error.message : raw
      } catch { detail = raw }
    }
    return new RuntimeError(error.message.includes(detail) ? error.message : `${error.message}\n${detail}`, { cause: error })
  } catch { return RuntimeError.from(error) }
}

const resolveContentObjects = (context: typeof Conversation.Type): Effect.Effect<ReadonlyMap<string, Uint8Array>, Error> => Effect.gen(function* () {
  const content = context.flatMap(message => (message.role === "user" || message.role === "tool") && "content" in message && message.content !== undefined ? message.content : [])
  if (!content.some(part => part.type === "file")) return new Map<string, Uint8Array>()
  const service = yield* Effect.serviceOption(ObjectStorage)
  if (Option.isNone(service)) return yield* Effect.fail(new RuntimeError("File input requires a runtime ObjectStorage service"))
  const resolved = yield* ObjectStorage.resolve(content).pipe(Effect.provideService(ObjectStorage, service.value), Effect.mapError(RuntimeError.from))
  const objects = new Map<string, Uint8Array>()
  content.forEach((part, index) => {
    const value = resolved[index]
    if (part.type === "file" && value?.type === "file") objects.set(objectKeyOf(part.object), value.bytes)
  })
  return objects
})

const jsonSchemaOf = (value: unknown) => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value)

const outputDecode = (schema: Schema.Top, text: string) => Effect.result(Effect.try({
  try: () => JSON.parse(text),
  catch: RuntimeError.from,
}).pipe(Effect.flatMap(value => (Schema.decodeUnknownEffect as unknown as (schema: Schema.Top) => (value: unknown) => Effect.Effect<unknown, Error>)(schema)(value))))

const promptPartsOf = (content: ReadonlyArray<MessageContentPart>, objects: ReadonlyMap<string, Uint8Array>) => content.map((part) => {
  if (part.type === "text") return Prompt.makePart("text", { text: part.text })
  const data = objects.get(objectKeyOf(part.object))
  if (data === undefined) throw new RuntimeError(`Unresolved object: ${objectKeyOf(part.object)}`)
  return Prompt.filePart({ mediaType: part.mediaType, data, ...(part.filename === undefined ? {} : { fileName: part.filename }) })
})

// modelServices adapts native AI providers to the agent's model service without executing tools.
export function modelServices(options: ModelServiceOptions = {}) {
  for (const [name, value] of Object.entries(options)) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RuntimeError(`${name} must be a positive safe integer`)
  return Layer.effect(Model, Effect.gen(function* () {
    const lock = yield* ModelLock
    const languageModel = yield* LanguageModel.LanguageModel
    const selection = yield* ModelSelection
    const fallback = yield* BindingSettings
    const settingsOf = (input: ModelInput) => Effect.gen(function* () {
      const resolved = lock.resolve(input.model)
      const settings = yield* (selection.settings?.(resolved.model) ?? Effect.succeed(fallback))
      return { resolved, settings }
    })
    const promiseTimeoutMs = (input: ModelInput) => Effect.gen(function* () {
      const { settings } = yield* settingsOf(input)
      return options.promiseTimeoutMs ?? options.timeoutMs ?? settings.policy.timeout.attemptMs ?? DEFAULT_MODEL_TIMEOUT_MS
    })
    const retry = (input: ModelInput) => settingsOf(input).pipe(Effect.map(({ settings }) => modelRetry(settings.policy.retry)))
    return { promiseTimeoutMs, retry, call: (input, context) => Effect.gen(function* () {
      const { resolved, settings } = yield* settingsOf(input)
      const timeoutMs = options.timeoutMs ?? settings.policy.timeout.attemptMs ?? DEFAULT_MODEL_TIMEOUT_MS
      const objects = yield* resolveContentObjects(input.context)
      const toolkit = yield* Effect.try({
        try: () => Toolkit.make(...input.tools.map(tool => AiTool.dynamic(tool.name, {
          description: `${tool.description} Execution: ${tool.execution ?? DEFAULT_METHOD_EXECUTION}.${tool.promiseTimeoutMs === undefined ? "" : ` Promise timeout: ${tool.promiseTimeoutMs}ms.`}`,
          parameters: Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(tool.inputSchema)),
            settings.schemaImport ?? DEFAULT_SCHEMA_IMPORT_OPTIONS,
          )),
        }))),
        catch: RuntimeError.from,
      })
      const responseFormat = input.output === undefined ? undefined : {
        type: "json" as const,
        objectName: input.output.name,
        schema: SchemaRepresentation.fromJsonSchemaDocument(
          JsonSchema.fromSchemaDraft07(jsonSchemaOf(input.output.schema)),
          settings.schemaImport ?? DEFAULT_SCHEMA_IMPORT_OPTIONS,
        ),
      }
      if (input.output !== undefined && (settings.output?.guarantee !== "native" || (input.tools.length > 0 && !settings.output.withTools))) {
        const reason = settings.output?.guarantee !== "native"
          ? `model ${resolved.model.model_id} does not declare native structured-output support`
          : `model ${resolved.model.model_id} cannot combine native structured output with tools`
        return yield* Effect.fail(new RuntimeError(reason))
      }
      const request = {
        prompt: Prompt.fromMessages([
          Prompt.makeMessage("system", { content: input.system }),
          ...input.context.flatMap((message): readonly Prompt.Message[] => {
            if (message.role === "user") return [Prompt.makeMessage("user", { content: "text" in message ? [Prompt.makePart("text", { text: message.text })] : promptPartsOf(message.content, objects) })]
            if (message.role === "tool") {
              const result: string | ToolResultContent = message.content === undefined ? message.text : { type: "content", value: promptPartsOf(message.content, objects) }
              return [Prompt.makeMessage("tool", { content: [Prompt.makePart("tool-result", { id: message.providerId, name: message.name, result, isFailure: message.error, providerExecuted: false })] })]
            }
            const continuation = message.continuation
            if (continuation && continuation.provider === settings.provider && continuation.protocol === settings.protocol && continuation.model === resolved.model.model_id) {
              return Schema.decodeUnknownSync(Prompt.Prompt)(continuation.payload).content
            }
            return [Prompt.makeMessage("assistant", { content: [
              ...(message.text ? [Prompt.makePart("text", { text: message.text })] : []),
              ...message.toolCalls.map(call => Prompt.makePart("tool-call", { id: call.providerId, name: call.name, params: call.input, providerExecuted: false })),
            ] })]
          }),
        ]),
        toolkit,
        toolChoice: input.tools.length ? "auto" as const : "none" as const,
        disableToolCallResolution: true as const,
      }
      const stream = responseFormat === undefined
        ? languageModel.streamText(request)
        : languageModel.streamText(request).pipe(Stream.provideService(ResponseFormat, responseFormat))
      const generated = context
        ? collectModelStream(stream, resolved.model, context, settings.policy.timeout)
        : responseFormat === undefined
          ? languageModel.generateText(request).pipe(Effect.map(response => ({ response, continuation: Prompt.fromResponseParts(response.content) })))
          : languageModel.generateText(request).pipe(Effect.provideService(ResponseFormat, responseFormat), Effect.map(response => ({ response, continuation: Prompt.fromResponseParts(response.content) })))
      const collected = yield* generated.pipe(
        Effect.provideService(CurrentModel, resolved.model),
        Effect.timeout(timeoutMs),
        Effect.mapError(error => AiError.isAiError(error) ? modelError(error) : RuntimeError.from(error)),
      )
      const { response } = collected
      if (response.finishReason === "length") return yield* Effect.fail(new RuntimeError(`Model reached maxOutputTokens=${settings.policy.maxOutputTokens}`))
      let outputErrors: string[] | undefined
      if (input.output !== undefined) {
        const decoded = yield* outputDecode(responseFormat!.schema, response.text)
        if (decoded._tag === "Failure") outputErrors = [decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure)]
      }
      const toolCalls = response.toolCalls.map(call => ({ callId: call.id, name: call.name, input: Schema.decodeUnknownSync(Schema.Json)(call.params) }))
      const finish = response.content.find(part => part.type === "finish")
      const usd = finish ? reportedCostOf(finish) : undefined
      const reasoning = response.reasoningText
      const continuation = response.reasoning.length === 0 ? undefined : {
        provider: settings.provider, protocol: settings.protocol, model: resolved.model.model_id,
        payload: yield* Schema.encodeEffect(Prompt.Prompt)(collected.continuation).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json))),
      }
      return { text: response.text, toolCalls, ...(outputErrors === undefined ? {} : { outputErrors }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(continuation === undefined ? {} : { continuation }),
        usage: {
        ...(response.usage.inputTokens.total === undefined ? {} : { input: response.usage.inputTokens.total }),
        ...(response.usage.outputTokens.total === undefined ? {} : { output: response.usage.outputTokens.total }),
        usd: usd ?? null,
      } }
    }) } satisfies typeof Model.Service
  }))
}

// liveModelServices connects the agent to Tardie's locked provider configuration and credentials.
export function liveModelServices(options: Omit<ModelBindingOptions, "observer"> & ModelServiceOptions) {
  const { timeoutMs, promiseTimeoutMs, ...binding } = options
  return modelServices({ ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs }) }).pipe(Layer.provideMerge(modelLayer(binding)))
}

export const generate = Generate.layer(input => Effect.gen(function* () {
  const model = yield* Model
  const execution = yield* EffectExecution
  const timeoutMs = typeof model.promiseTimeoutMs === "function" ? yield* model.promiseTimeoutMs(input) : model.promiseTimeoutMs
  if (model.submit) return Generate.defer(yield* execution.submit(model.submit(input, execution), { timeoutMs }))
  const retry = model.retry ? yield* model.retry(input) : undefined
  const call = model.call(input, { publish: execution.publish, purpose: "inference" })
  const reply = durablePromise(execution.ref, { success: ModelReplySchema, error: Schema.String })
  const handle = yield* execution.fork((retry ? execution.retry(call, retry) : call).pipe(
    Effect.exit,
    Effect.map(exit => Exit.isSuccess(exit) ? reply.succeed(exit.value) : reply.fail(Cause.pretty(exit.cause))),
  ), { timeoutMs })
  return Generate.defer(handle)
}).pipe(Effect.mapError(String)), { cancel: (input, context) => Model.use(model => model.cancel?.(input, context) ?? Effect.void) })

export const summarize = Summarize.layer(input => Effect.gen(function* () {
  const execution = yield* EffectExecution
  const model = yield* Model
  const retry = model.retry ? yield* model.retry(input) : undefined
  const call = model.call(input, { publish: execution.publish, purpose: "compaction" })
  return yield* (retry ? execution.retry(call, retry) : call)
}).pipe(
  Effect.flatMap(reply => reply.text.trim() ? Effect.succeed(reply) : Effect.fail("Compaction returned an empty summary")),
  Effect.mapError(String),
))

export const modelActs = Layer.merge(generate, summarize)
