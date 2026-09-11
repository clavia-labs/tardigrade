import { BedrockConfig } from "../providers/bedrock"
import { observerPolicyOf, deltaDelivery } from "./observer"
import type { InferenceObserver, InferDelta } from "@clavia/tardigrade-agent/inference/observer"
import { OpenAiLanguageModel } from "@tardie/ai-openai"
import { OpenAiLanguageModel as CompatLanguageModel } from "@tardie/ai-openai-compat"
import { AnthropicLanguageModel } from "@tardie/ai-anthropic"
import { sumUsage, type Usage, type ModelPricing } from "@clavia/tardigrade-agent/inference/usage"
import { responseUsageOf, type ReportedCostReader } from "./usage"
import { FetchHttpClient } from "effect/unstable/http"
import { Effect, JsonSchema, Layer, Option, Schema, SchemaRepresentation } from "effect"
import { AiError, IdGenerator, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
import { Infer } from "@clavia/tardigrade-agent/inference/contract"
import { modelRequest } from "@clavia/tardigrade-agent/inference/request"
import { TurnError, type Action, type ToolCall } from "@clavia/tardigrade-agent/log/events"
import type { AgentMessage } from "@clavia/tardigrade-agent/projection/messages"
import { collectResponse, ToolCallValidationError } from "./response"
import { providerLayer, ProviderRequestKey, type ProviderOptions } from "../providers/layer"

import { fallbackSystemFor, outputModeOf, outputSchemaFor, outputNameFor, type OutputCapability } from "./output"

import { requestPolicyOf, retryRequest, RequestFailed, StreamTruncated, type RequestOptions } from "./request"

export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

const jsonObject = Schema.Record(Schema.String, Schema.Json)

// inferenceLayer binds complete provider responses to the agent inference service (inference/binding.test.ts).
export const inferenceLayer = (options: ProviderOptions & { readonly schemaImport?: SchemaRepresentation.FromJsonSchemaOptions; readonly providerId?: string; readonly observer?: InferenceObserver; readonly endpoint: string; readonly output?: OutputCapability; readonly pricing?: ModelPricing; readonly reportedCostUsd?: ReportedCostReader } & RequestOptions) => {
  const providerId = options.providerId ?? options.provider
  const endpoint = { provider: providerId, model: options.model.model }
  const outputPolicy = { ...endpoint, ...(options.output === undefined ? {} : { output: options.output }) }
  const protocol = options.provider === "bedrock" ? "bedrock-converse" : options.provider === "openai" ? "openai-responses" : options.provider === "openai-compat" ? "openai-chat-completions" : "anthropic"
  const observerPolicy = options.observer === undefined ? undefined : observerPolicyOf(options.observer)
  const ceiling = options.maxOutputTokens ?? (options.provider === "bedrock" ? options.model.config?.inferenceConfig?.maxTokens : options.provider === "anthropic" ? options.model.config?.max_tokens : options.model.config?.max_output_tokens)
  const policy = requestPolicyOf({ ...options, ...(ceiling == null ? {} : { maxOutputTokens: ceiling }) })
  return Layer.effect(Infer, Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel
  return {
  react: (request, key, signal, onDelta) => Effect.gen(function* () {
    if (signal?.aborted) return yield* Effect.interrupt
    const delivery = options.observer === undefined || observerPolicy === undefined ? undefined : yield* deltaDelivery(options.observer, observerPolicy)
    return yield* Effect.suspend(() => {
    const spend: Usage[] = []
    let observed: Response.AnyPart[] = []
    let modeEvidence: Pick<Action, "mode"> = {}
    return Effect.gen(function* () {
    if (request.model !== undefined && (request.model.provider !== providerId || request.model.model_id !== options.model.model)) return { kind: "fail", error: "Effect AI binding does not serve the requested model" } satisfies Action
    const req = modelRequest(request.trajectory, request, request.context ?? {})
    const selected = outputModeOf(req, outputPolicy)
    if ("errors" in selected) return {
      kind: "fail", error: { message: selected.errors.join("\n"), code: "output_unsupported" }, endpoint,
      failure: { cause: "output_unsupported", attempts: 0, policy: outputPolicy }
    } satisfies Action
    const mode = selected.mode
    modeEvidence = req.output === undefined ? {} : { mode }
    const fallbackSystem = fallbackSystemFor(req.output, mode)
    const system = fallbackSystem === undefined ? req.system : `${req.system}\n\n${fallbackSystem}`
    const outputSchema = outputSchemaFor(req.output, mode)
    const responseFormat = outputSchema === undefined ? undefined : {
      type: "json" as const, objectName: outputNameFor(req.output, mode)!,
      schema: yield* Effect.try(() => importSchema(outputSchema, options.schemaImport))
    }
    const tools = yield* Effect.try(() => req.tools.map((spec) => Tool.dynamic(spec.name, {
      description: spec.description,
      parameters: importSchema(spec.inputSchema, options.schemaImport),
      failureMode: "return"
    })))
    const names = new Map<string, string>()
    const history = yield* Effect.try(() => req.messages.flatMap((message): ReadonlyArray<Prompt.Message> => {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name)
      const continuation = message.continuation
      if (continuation?.format === "effect-prompt") {
        const native = Schema.decodeUnknownSync(Prompt.Prompt)({ content: continuation.payload }).content
        if (continuation.provider === providerId && continuation.protocol === protocol && continuation.model === options.model.model) return native
        const reasoning = native.flatMap((entry) => entry.role === "assistant"
          ? entry.content.flatMap((part) => part.type === "reasoning" && part.text.trim() !== "" ? [part.text] : [])
          : [])
        return promptMessage(message, names, reasoning)
      }
      return promptMessage(message, names)
    }))
    const transport = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
    const fetchOptions = { ...transport, timeout: false }
    const response = yield* retryRequest((maxOutputTokens) => Effect.gen(function* () {
    observed = []
    let reported: Usage | undefined
    let servedModel = options.model.model
    let sequence = 0
    let blockIndex = -1
    const physicalAttempt = yield* IdGenerator.defaultIdGenerator.generateId()
    const result = yield* collectResponse(Prompt.setSystem(Prompt.fromMessages(history), system), Toolkit.make(...tools), (part) => {
      observed.push(part)
      if (part.type === "response-metadata" && part.modelId !== undefined) servedModel = part.modelId
      if (part.type === "finish") reported = responseUsageOf(part, { provider: providerId, model: servedModel }, options.pricing, options.reportedCostUsd?.(part))
      if (part.type === "text-start" || part.type === "reasoning-start") blockIndex += 1
      if (part.type === "text-delta" || part.type === "reasoning-delta") {
        const delta: InferDelta = { ...request.identity, logicalAttempt: key ?? request.identity.turn, physicalAttempt, model: { provider: providerId, model_id: options.model.model }, blockIndex: Math.max(0, blockIndex), sequence: sequence++, text: part.delta, ...(part.type === "reasoning-delta" ? { kind: "reasoning" as const } : {}) }
        onDelta?.(delta)
        return delivery?.offer(delta).pipe(Effect.asVoid)
      }
    }, responseFormat, policy.stream).pipe(Effect.ensuring(Effect.sync(() => {
      if (reported !== undefined) spend.push(reported)
      else spend.push({})
    })))
    if (result.parts.some((part) => part.type === "finish" && part.reason === "length")) return yield* new StreamTruncated({ maxOutputTokens })
    return result
    }).pipe((effect) => options.provider === "bedrock"
      ? effect.pipe(Effect.provideService(BedrockConfig, { inferenceConfig: { maxTokens: maxOutputTokens } }))
      : options.provider === "openai"
      ? OpenAiLanguageModel.withConfigOverride(effect, { max_output_tokens: maxOutputTokens })
      : options.provider === "openai-compat"
      ? CompatLanguageModel.withConfigOverride(effect, { max_output_tokens: maxOutputTokens })
      : AnthropicLanguageModel.withConfigOverride(effect, { max_tokens: maxOutputTokens })), policy).pipe(
      Effect.provideService(ProviderRequestKey, key),
      Effect.provideService(FetchHttpClient.RequestInit, fetchOptions)
    )
    const calls: ToolCall[] = []
    const errors: TurnError[] = []
    for (const part of response.parts) {
      if (part.type === "tool-call") calls.push({ callId: part.id, name: part.name, arguments: part.params })
      if (part.type === "error") {
        if (!Schema.is(ToolCallValidationError)(part.error)) {
          errors.push(yield* errorOf(part.error))
          continue
        }
        const error = part.error
        calls.push({ callId: error.id, name: error.name, arguments: error.params, validationError: JSON.stringify(error.cause) })
      }
    }
    const evidence = responseEvidence(response.parts)
    const served = {
      ...modeEvidence,
      endpoint,
      ...evidence,
      continuation: { format: "effect-prompt", protocol, provider: providerId, model: options.model.model, endpoint: options.endpoint, payload: response.continuation.content },
    }
    if (errors.length > 0) return { kind: "fail", ...served, error: errors.length === 1 ? errors[0]! : { message: "The provider returned multiple errors.", details: yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(TurnError)))(errors) }, failure: { cause: "inference_error", attempts: spend.length } } satisfies Action
    const finish = evidence.response?.finishReason
    if (finish !== "stop" && finish !== "tool-calls") return {
      kind: "fail", ...served,
      error: { message: `Effect AI response did not finish successfully: ${finish ?? "missing finish"}`, code: finish === "content-filter" ? "refused" : "inference_error" },
      failure: { cause: finish === "content-filter" ? "refused" : "inference_error", attempts: spend.length }
    } satisfies Action
    const text = evidence.text ?? ""
    return calls.length > 0
      ? { kind: "calls", calls: [calls[0]!, ...calls.slice(1)], text, ...served } satisfies Action
      : { kind: "complete", output: text, ...served } satisfies Action
  }).pipe(
    (effect) => signal === undefined ? effect : Effect.raceFirst(effect, Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", abort))
    })),
    Effect.provideService(LanguageModel.LanguageModel, model),
    Effect.catch((error) => Effect.gen(function*() {
      const cause = error instanceof RequestFailed ? error.cause : error
      const failure = cause instanceof StreamTruncated
        ? { message: `The response reached the ${cause.maxOutputTokens}-token output limit.`, code: "output_limit", isRetryable: false }
        : yield* errorOf(cause)
      return {
        kind: "fail",
        error: failure,
        ...modeEvidence,
        endpoint,
        ...responseEvidence(observed),
        ...(error instanceof RequestFailed ? { failure: { cause: cause instanceof StreamTruncated ? "output_limit" : "inference_error", attempts: error.attempts, policy: error.policy } } : {})
      } satisfies Action
    })),
    Effect.map((action): Action => spend.length === 0 ? action : { ...action, usage: sumUsage(spend) }))
  }).pipe(Effect.ensuring(delivery?.finish ?? Effect.void))
  })
} satisfies typeof Infer.Service
})).pipe(Layer.provide(providerLayer(options.output?.guarantee !== "native" || options.provider === "bedrock" ? options : options.provider === "anthropic"
  ? { ...options, model: { ...options.model, config: { ...options.model.config, structuredOutputs: true, strictJsonSchema: true } } }
  : options.provider === "openai-compat"
  ? { ...options, model: { ...options.model, config: { ...options.model.config, strictJsonSchema: true } } }
  : { ...options, model: { ...options.model, config: { ...options.model.config, strictJsonSchema: true } } })))

}

const promptMessage = (message: AgentMessage, names: ReadonlyMap<string, string>, reasoning: ReadonlyArray<string> = []): ReadonlyArray<Prompt.Message> => {
  if (message.role === "user") return [Prompt.userMessage({ content: [Prompt.makePart("text", { text: message.content ?? "" })] })]
  if (message.role === "tool") return [Prompt.toolMessage({ content: [Prompt.makePart("tool-result", {
    id: message.toolCallId ?? "", name: names.get(message.toolCallId ?? "") ?? "", result: message.content ?? "", isFailure: message.isFailure ?? false, providerExecuted: false
  })] })]
  return [Prompt.assistantMessage({ content: [
    ...reasoning.map((text) => Prompt.makePart("text", { text })),
    ...(message.content ? [Prompt.makePart("text", { text: message.content })] : []),
    ...(message.toolCalls ?? []).map((call) => Prompt.makePart("tool-call", { id: call.id, name: call.name, params: JSON.parse(call.arguments), providerExecuted: false }))
  ] })]
}

const importSchema = (schema: unknown, options: SchemaRepresentation.FromJsonSchemaOptions = DEFAULT_SCHEMA_IMPORT_OPTIONS) => Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(jsonObject)(schema)), options))

const responseEvidence = (parts: ReadonlyArray<Response.AnyPart>) => {
  let text = ""
  let reasoning = ""
  let response: NonNullable<Action["response"]> = {}
  for (const part of parts) {
    if (part.type === "text-delta") text += part.delta
    if (part.type === "reasoning-delta") reasoning += part.delta
    if (part.type === "response-metadata") response = { ...response, ...(part.id === undefined ? {} : { id: part.id }), ...(part.modelId === undefined ? {} : { model: part.modelId }) }
    if (part.type === "finish") response = { ...response, finishReason: part.reason }
  }
  return { ...(text === "" ? {} : { text }), ...(reasoning === "" ? {} : { reasoning }), ...(Object.keys(response).length === 0 ? {} : { response }) }
}

// errorOf uses the native error codec to preserve redacted HTTP evidence (inference/errors.test.ts).
const errorOf = (cause: unknown): Effect.Effect<TurnError> => Effect.gen(function* () {
  if (AiError.isAiError(cause)) return {
    message: cause.message,
    code: cause.reason._tag,
    isRetryable: cause.isRetryable,
    ...("http" in cause.reason && cause.reason.http?.response !== undefined ? { statusCode: cause.reason.http.response.status } : {}),
    details: yield* Schema.encodeEffect(Schema.fromJsonString(AiError.AiError))(cause).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))), Effect.catch((error) => Effect.succeed({ encodingError: String(error) })))
  }
  return {
    message: cause instanceof Error ? cause.message : typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" ? cause.message : "The provider returned an error.",
    ...(Schema.is(Schema.Json)(cause) ? { details: cause } : {})
  }
})
