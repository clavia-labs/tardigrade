import { modelRetry } from "./model-retry"
import type { RetryOptions } from "@clavia/tardigrade-core/services/effect-execution"
import { ModelInfo } from "../actor/context"
import { RuntimeError, type ExecutionHandle, type ActCancellation, durablePromise, EffectExecution } from "@clavia/tardigrade-core"
import { Effect, Layer, Context, JsonSchema, Schema, SchemaRepresentation, Cause, Exit, Option, Stream } from "effect"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { ObjectStorage, objectKeyOf } from "@clavia/tardigrade-model/object"
import { AiError, LanguageModel, Prompt, type Response, Tool as AiTool, Toolkit } from "effect/unstable/ai"
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
import { PreparedModelContext } from "../contracts/model-context"
import { resolveModelInput } from "./model-context"
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
  readonly promiseTimeoutMs?: number | null | ((input: ModelInput) => Effect.Effect<number | null, Error>)
  readonly submit?: (input: ModelInput, context: Pick<typeof EffectExecution.Service, "ref" | "signal" | "publish">) => Effect.Effect<ExecutionHandle, Error>
  readonly cancel?: (input: ModelInput, context: Omit<ActCancellation, "request">) => Effect.Effect<void, Error>
}>()("example/Model") {}

export const DEFAULT_MODEL_TIMEOUT_MS = 90_000
export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions
export const DEFAULT_MODEL_IMAGE_TRANSPORT = "inline"
export type ModelImageTransport = "inline" | "url"

const isModelImageTransport = (value: unknown): value is ModelImageTransport => value === "inline" || value === "url"

// DEFAULT_TOOL_SCHEMA_IMPORT_OPTIONS closes tool objects with declared properties when additionalProperties is omitted; a binding's schemaImport replaces it (packages/platform/test/bun/rpc-libraries.test.ts).
export const DEFAULT_TOOL_SCHEMA_IMPORT_OPTIONS = {
  ...DEFAULT_SCHEMA_IMPORT_OPTIONS,
  onEnter: (schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
    schema.type === "object" && schema.properties !== undefined && schema.additionalProperties === undefined ? { ...schema, additionalProperties: false } : schema,
} satisfies SchemaRepresentation.FromJsonSchemaOptions

export interface ModelServiceOptions {
  // Opt in only for tool-using inference; summaries and structured outputs still fail closed.
  readonly continueOnOutputLimit?: boolean
  readonly timeoutMs?: number | null
  readonly promiseTimeoutMs?: number | null
  // imageTransport selects URL-capable storage for images; URL failures stop without byte fallback (platform/test/bun/model-image-url.test.ts).
  readonly imageTransport?: ModelImageTransport | ((model: ModelRef) => Effect.Effect<ModelImageTransport, Error>)
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

const fileKey = (part: Extract<MessageContentPart, { readonly type: "file" }>) => `${objectKeyOf(part.object)}\0${part.mediaType}`

const resolveContentObjects = (context: typeof Conversation.Type, imageTransport: NonNullable<ModelServiceOptions["imageTransport"]>, model: ModelRef): Effect.Effect<ReadonlyMap<string, Prompt.FilePart["data"]>, Error> => Effect.gen(function* () {
  const content = context.flatMap(message => (message.role === "user" || message.role === "tool") && "content" in message && message.content !== undefined ? message.content : [])
  const objects = new Map<string, Prompt.FilePart["data"]>()
  const files = new Map(content.flatMap(part => part.type === "file" ? [[fileKey(part), part] as const] : []))
  if (!files.size) return objects
  const images = [...files].filter(([, file]) => file.mediaType.startsWith("image/"))
  const transport = typeof imageTransport === "function" ? images.length ? yield* imageTransport(model) : DEFAULT_MODEL_IMAGE_TRANSPORT : imageTransport
  if (!isModelImageTransport(transport)) return yield* Effect.fail(new RuntimeError("Image transport selector must return inline or url"))
  const service = yield* Effect.serviceOption(ObjectStorage)
  if (Option.isNone(service)) return yield* Effect.fail(new RuntimeError("File input requires a runtime ObjectStorage service"))
  const storage = service.value
  if (transport === "url") {
    if (images.length && storage.url === undefined) return yield* Effect.fail(new RuntimeError("Image URL transport requires ObjectStorage.url"))
    for (const [key, file] of images) {
      const data = yield* storage.url!(file.object, { mediaType: file.mediaType }).pipe(Effect.mapError(RuntimeError.from))
      objects.set(key, data)
    }
  }
  const remaining = [...files.values()].filter(part => !objects.has(fileKey(part)))
  if (!remaining.length) return objects
  const resolved = yield* ObjectStorage.resolve(remaining).pipe(Effect.provideService(ObjectStorage, storage), Effect.mapError(RuntimeError.from))
  remaining.forEach((part, index) => {
    const value = resolved[index]
    if (value?.type === "file") objects.set(fileKey(part), value.bytes)
  })
  return objects
})

const jsonSchemaOf = (value: unknown) => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value)

const outputDecode = (schema: Schema.Top, text: string) => Effect.result(Effect.try({
  try: () => JSON.parse(text),
  catch: RuntimeError.from,
}).pipe(Effect.flatMap(value => (Schema.decodeUnknownEffect as unknown as (schema: Schema.Top) => (value: unknown) => Effect.Effect<unknown, Error>)(schema)(value))))

const promptPartsOf = (content: ReadonlyArray<MessageContentPart>, objects: ReadonlyMap<string, Prompt.FilePart["data"]>) => content.map((part) => {
  if (part.type === "text") return Prompt.makePart("text", { text: part.text })
  const data = objects.get(fileKey(part))
  if (data === undefined) throw new RuntimeError(`Unresolved object: ${objectKeyOf(part.object)}`)
  return Prompt.filePart({ mediaType: part.mediaType, data, ...(part.filename === undefined ? {} : { fileName: part.filename }) })
})

// carriesProviderMetadata detects metadata that rebuilding plain tool calls would discard.
const carriesProviderMetadata = (metadata: Response.ProviderMetadata) =>
  Object.values(metadata).some(entry => entry !== null && (typeof entry !== "object" || Object.values(entry).some(value => value !== null)))

// modelServices adapts native AI providers to the agent's model service without executing tools.
export function modelServices(options: ModelServiceOptions = {}) {
  const { imageTransport = DEFAULT_MODEL_IMAGE_TRANSPORT, continueOnOutputLimit = false, ...timeouts } = options
  if (typeof continueOnOutputLimit !== "boolean") throw new RuntimeError("continueOnOutputLimit must be boolean")
  if (typeof imageTransport !== "function" && !isModelImageTransport(imageTransport)) throw new RuntimeError("imageTransport must be inline, url, or a model transport selector")
  for (const [name, value] of Object.entries(timeouts)) if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new RuntimeError(`${name} must be a positive safe integer or null`)
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
      return options.promiseTimeoutMs !== undefined ? options.promiseTimeoutMs : options.timeoutMs !== undefined ? options.timeoutMs : settings.policy.timeout.attemptMs ?? DEFAULT_MODEL_TIMEOUT_MS
    })
    const retry = (input: ModelInput) => settingsOf(input).pipe(Effect.map(({ settings }) => ({ ...modelRetry(settings.policy.retry), attemptTimeoutMs: options.timeoutMs !== undefined ? options.timeoutMs : settings.policy.timeout.attemptMs ?? DEFAULT_MODEL_TIMEOUT_MS })))
    return { promiseTimeoutMs, retry, call: (input, context) => Effect.gen(function* () {
      const { resolved, settings } = yield* settingsOf(input)
      const objects = yield* resolveContentObjects(input.context, imageTransport, resolved.model)
      const toolkit = yield* Effect.try({
        try: () => Toolkit.make(...input.tools.map(tool => AiTool.dynamic(tool.name, {
          description: `${tool.description} Execution: ${tool.execution ?? DEFAULT_METHOD_EXECUTION}.${tool.promiseTimeoutMs === undefined ? "" : ` Promise timeout: ${tool.promiseTimeoutMs}ms.`}`,
          parameters: Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(tool.inputSchema)),
            settings.schemaImport ?? DEFAULT_TOOL_SCHEMA_IMPORT_OPTIONS,
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
        Effect.mapError(error => AiError.isAiError(error) ? modelError(error) : RuntimeError.from(error)),
      )
      const { response } = collected
      const outputLimit = response.finishReason === "length" ? settings.policy.maxOutputTokens : undefined
      if (outputLimit !== undefined && (!continueOnOutputLimit || context?.purpose !== "inference" || input.output !== undefined))
        return yield* Effect.fail(new RuntimeError(`Model reached maxOutputTokens=${outputLimit}`))
      let outputErrors: string[] | undefined
      if (input.output !== undefined) {
        const decoded = yield* outputDecode(responseFormat!.schema, response.text)
        if (decoded._tag === "Failure") outputErrors = [decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure)]
      }
      const toolCalls = outputLimit === undefined ? response.toolCalls.map(call => ({ callId: call.id, name: call.name, input: Schema.decodeUnknownSync(Schema.Json)(call.params) })) : []
      const finish = response.content.find(part => part.type === "finish")
      const usd = finish ? reportedCostOf(finish) : undefined
      const reasoning = response.reasoningText
      // A truncated call cannot be executed or sent back as an unresolved provider call.
      // Retain native reasoning/text continuation and reported usage for the next durable generation.
      const providerContinuation = outputLimit === undefined ? collected.continuation : Prompt.fromMessages(collected.continuation.content.map(message =>
        message.role === "assistant" ? { ...message, content: message.content.filter(part => part.type !== "tool-call") } : message))
      const continuation = response.reasoning.length === 0 && (outputLimit !== undefined || !response.toolCalls.some(call => carriesProviderMetadata(call.metadata))) ? undefined : {
        provider: settings.provider, protocol: settings.protocol, model: resolved.model.model_id,
        payload: yield* Schema.encodeEffect(Prompt.Prompt)(providerContinuation).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json))),
      }
      return { text: response.text, toolCalls, ...(outputLimit === undefined ? {} : { outputLimit }), ...(outputErrors === undefined ? {} : { outputErrors }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(continuation === undefined ? {} : { continuation }),
        usage: {
        ...(response.usage.inputTokens.total === undefined ? {} : { input: response.usage.inputTokens.total }),
        ...(response.usage.outputTokens.total === undefined ? {} : { output: response.usage.outputTokens.total }),
        ...(response.usage.inputTokens.cacheRead === undefined ? {} : { cacheRead: response.usage.inputTokens.cacheRead }),
        ...(response.usage.inputTokens.cacheWrite === undefined ? {} : { cacheWrite: response.usage.inputTokens.cacheWrite }),
        usd: usd ?? null,
      } }
    }) } satisfies typeof Model.Service
  }))
}

// liveModelServices connects the agent to Tardie's locked provider configuration and credentials.
export function liveModelServices(options: Omit<ModelBindingOptions, "observer"> & ModelServiceOptions) {
  const { timeoutMs, promiseTimeoutMs, imageTransport, continueOnOutputLimit, ...binding } = options
  return modelServices({ ...(continueOnOutputLimit === undefined ? {} : { continueOnOutputLimit }), ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs }), ...(imageTransport === undefined ? {} : { imageTransport }) }).pipe(Layer.provideMerge(modelLayer(binding)))
}

const durableModelCall = (input: ModelInput, purpose: ModelCallContext["purpose"]) => Effect.gen(function* () {
  const model = yield* Model
  const execution = yield* EffectExecution
  const retry = yield* inferenceRetry(model, input)
  const configured = typeof model.promiseTimeoutMs === "function" ? yield* model.promiseTimeoutMs(input) : model.promiseTimeoutMs
  const timeoutMs = configured !== undefined ? configured : retry.attemptTimeoutMs === undefined ? DEFAULT_MODEL_TIMEOUT_MS : retry.attemptTimeoutMs
  if (purpose === "inference" && model.submit) return yield* execution.submit(execution.retry(model.submit(input, execution), retry), { timeoutMs })
  const call = model.call(input, { publish: execution.publish, purpose })
  const reply = durablePromise(execution.ref, { success: ModelReplySchema, error: Schema.String })
  return yield* execution.fork(execution.retry(call, retry).pipe(
    Effect.flatMap(reply => purpose === "compaction" && !reply.text.trim() ? Effect.fail("Compaction returned an empty summary") : Effect.succeed(reply)),
    Effect.exit,
    Effect.map(exit => Exit.isSuccess(exit) ? reply.succeed(exit.value) : reply.fail(Cause.pretty(exit.cause))),
  ), { timeoutMs })
}).pipe(Effect.mapError(String))

export const generate = Generate.layer(input => Effect.gen(function* () {
  const execution = yield* EffectExecution
  const prepared = yield* Effect.serviceOption(PreparedModelContext)
  const value = yield* Effect.try(() => resolveModelInput(input, execution.get, Option.getOrUndefined(prepared)))
  return yield* durableModelCall(value, "inference").pipe(Effect.map(Generate.defer))
}).pipe(Effect.mapError(String)), {
  cancel: (input, context) => Effect.try(() => resolveModelInput(input, context.get)).pipe(
    Effect.flatMap(value => Model.use(model => model.cancel?.(value, context) ?? Effect.void)),
  ),
})

export const summarize = Summarize.layer(input => durableModelCall(input, "compaction").pipe(Effect.map(Summarize.defer)))

export const modelActs = Layer.merge(generate, summarize)

const inferenceRetry = (model: typeof Model.Service, input: ModelInput) => Effect.gen(function* () {
  // @effect-diagnostics-next-line effectSucceedWithVoid:off: The retry decision requires an undefined value to stop.
  const retry: RetryOptions<Error> = model.retry ? yield* model.retry(input) : { decide: () => Effect.succeed(undefined) }
  return { ...retry, attemptTimeoutMs: retry.attemptTimeoutMs === undefined ? DEFAULT_MODEL_TIMEOUT_MS : retry.attemptTimeoutMs }
})
