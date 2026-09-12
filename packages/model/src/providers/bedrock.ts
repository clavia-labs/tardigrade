import * as ProviderLanguageModel from "@tardie/ai"
import { Context, Effect, Encoding, Layer, Option, Schema, Stream } from "effect"
import { AiError, LanguageModel, Tool } from "effect/unstable/ai"
import type { Prompt, Response } from "effect/unstable/ai"
import type { BedrockRuntimeClientConfig, ContentBlock, ConverseStreamCommandInput, ConverseStreamCommandOutput, ConverseStreamOutput, Message } from "@aws-sdk/client-bedrock-runtime"

export type BedrockModelConfig = Omit<ConverseStreamCommandInput, "modelId" | "messages" | "system" | "toolConfig" | "outputConfig">
export type BedrockSend = (input: ConverseStreamCommandInput, signal: AbortSignal) => Promise<ConverseStreamCommandOutput>
export type BedrockClientOptions = BedrockRuntimeClientConfig | { readonly send: BedrockSend }
export class BedrockConfig extends Context.Service<BedrockConfig, BedrockModelConfig>()("tardie/BedrockConfig") {}

type ReasoningOptions = { readonly signature?: string; readonly redactedContent?: string }
declare module "effect/unstable/ai/Prompt" {
  interface ReasoningPartOptions { readonly bedrock?: ReasoningOptions }
}
declare module "effect/unstable/ai/Response" {
  interface ReasoningEndPartMetadata { readonly bedrock?: ReasoningOptions }
  interface FinishPartMetadata { readonly bedrock?: { readonly usage?: Schema.JsonObject } }
}

const failure = (description: string) => AiError.make({ module: "BedrockLanguageModel", method: "streamText", reason: AiError.InvalidRequestError.make({ description }) })
const providerError = (cause: unknown): AiError.AiError => {
  if (AiError.isAiError(cause)) return cause
  const name = cause instanceof Error ? cause.name : ""
  return AiError.make({ module: "BedrockLanguageModel", method: "streamText", reason: name === "ThrottlingException"
    ? AiError.RateLimitError.make({})
    : name === "ValidationException"
    ? AiError.InvalidRequestError.make({ description: String(cause) })
    : ["InternalServerException", "ServiceUnavailableException", "ModelStreamErrorException", "ModelTimeoutException", "ModelNotReadyException"].includes(name)
    ? AiError.InternalProviderError.make({ description: String(cause) })
    : AiError.UnknownError.make({ description: String(cause) }) })
}

// bedrockLayer supplies Converse streaming through the AWS SDK or an injected transport (providers/bedrock.test.ts).
export const bedrockLayer = (options: { readonly client: BedrockClientOptions; readonly model: { readonly model: string; readonly config?: BedrockModelConfig } }) => Layer.effect(LanguageModel.LanguageModel, Effect.gen(function* () {
  let send: BedrockSend
  if ("send" in options.client) send = options.client.send
  else {
    const sdk = yield* Effect.promise(() => import("@aws-sdk/client-bedrock-runtime"))
    const client = yield* Effect.acquireRelease(Effect.sync(() => new sdk.BedrockRuntimeClient({ ...options.client, maxAttempts: 1 })), (client) => Effect.sync(() => client.destroy()))
    send = (input, signal) => client.send(new sdk.ConverseStreamCommand(input), { abortSignal: signal })
  }
  const streamText = (request: LanguageModel.ProviderOptions) => Stream.unwrap(Effect.gen(function* () {
    const override: BedrockModelConfig = Option.getOrElse(yield* Effect.serviceOption(BedrockConfig), () => ({}))
    const config = { ...options.model.config, ...override, inferenceConfig: { ...options.model.config?.inferenceConfig, ...override.inferenceConfig } }
    const input = yield* Effect.try({ try: () => bedrockRequest(request, options.model.model, config), catch: providerError })
    const controller = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), (controller) => Effect.sync(() => controller.abort()))
    const response = yield* Effect.tryPromise({ try: () => send(input, controller.signal), catch: providerError })
    if (response.stream === undefined) return yield* failure("Bedrock returned no stream")
    const state = new BedrockResponse(request.tools)
    return Stream.fromAsyncIterable(abortable(response.stream, controller), providerError).pipe(Stream.mapEffect((event) => state.accept(event)), Stream.flatMap(Stream.fromIterable))
  }))
  return yield* ProviderLanguageModel.make({ streamText, generateText: () => Effect.fail(failure("The Bedrock bridge supports streamText only")) })
}))

const bedrockRequest = (request: LanguageModel.ProviderOptions, modelId: string, config: BedrockModelConfig): ConverseStreamCommandInput => {
  const messages: Message[] = []
  const system: { text: string }[] = []
  for (const message of request.prompt.content) {
    if (message.role === "system") { system.push({ text: message.content }); continue }
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = message.content.map(toBedrockPart)
    const previous = messages.at(-1)
    if (previous?.role === role) previous.content!.push(...content)
    else messages.push({ role, content })
  }
  const choice = request.toolChoice
  const tools = request.tools.filter((tool) => choice !== "none" && !(typeof choice === "object" && "oneOf" in choice && !choice.oneOf.includes(tool.name)))
  if (tools.some(Tool.isProviderDefined)) throw failure("Bedrock provider-defined tools are unsupported")
  return {
    ...config, modelId, messages, ...(system.length === 0 ? {} : { system }),
    ...(tools.length === 0 ? {} : { toolConfig: {
      tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: Tool.getDescription(tool) ?? tool.name, inputSchema: { json: nativeJson(Tool.getJsonSchema(tool)) } } })),
      toolChoice: typeof choice === "object" && "tool" in choice ? { tool: { name: choice.tool } } : choice === "required" || typeof choice === "object" && "oneOf" in choice && choice.mode === "required" ? { any: {} } : { auto: {} }
    } }),
    ...(request.responseFormat.type === "json" ? { outputConfig: { textFormat: { type: "json_schema", structure: { jsonSchema: { name: request.responseFormat.objectName ?? "response", schema: JSON.stringify(Tool.getJsonSchemaFromSchema(request.responseFormat.schema)) } } } } } : {})
  }
}

const toBedrockPart = (part: Prompt.UserMessage["content"][number] | Prompt.AssistantMessage["content"][number] | Prompt.ToolMessage["content"][number]): ContentBlock => {
  switch (part.type) {
    case "text": return { text: part.text }
    case "reasoning": {
      const native = part.options.bedrock
      if (native?.redactedContent !== undefined) return { reasoningContent: { redactedContent: Uint8Array.from(atob(native.redactedContent), (char) => char.charCodeAt(0)) } }
      return { reasoningContent: { reasoningText: { text: part.text, ...(native?.signature === undefined ? {} : { signature: native.signature }) } } }
    }
    case "tool-call": return { toolUse: { toolUseId: part.id, name: part.name, input: nativeJson(part.params) } }
    case "tool-result": return { toolResult: { toolUseId: part.id, status: part.isFailure ? "error" : "success", content: [{ text: typeof part.result === "string" ? part.result : JSON.stringify(part.result) }] } }
    default: throw failure(`Unsupported Bedrock prompt part: ${part.type}`)
  }
}

type Block = { readonly id: string; readonly type: "text" | "reasoning" | "tool"; text: string; name?: string; signature: string; redacted: number[] }
class BedrockResponse {
  private readonly blocks = new Map<number, Block>()
  private readonly calls = new Map<number, Block>()
  private stop: string | undefined
  constructor(private readonly tools: ReadonlyArray<Tool.Any>) {}
  accept(event: ConverseStreamOutput): Effect.Effect<Response.StreamPartEncoded[], AiError.AiError> {
    return Effect.gen({ self: this }, function* () {
      const parts: Response.StreamPartEncoded[] = []
      for (const key of ["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"] as const) {
        if (event[key] !== undefined) { const error = new Error(event[key].message); error.name = key[0]!.toUpperCase() + key.slice(1); return yield* providerError(error) }
      }
      if (event.contentBlockStart?.start?.toolUse !== undefined) {
        const { contentBlockIndex: index, start } = event.contentBlockStart
        const call = start?.toolUse
        if (index === undefined || call?.toolUseId === undefined || call.name === undefined || this.blocks.has(index)) return yield* failure("Invalid Bedrock tool block start")
        this.blocks.set(index, { type: "tool", id: call.toolUseId, name: call.name, text: "", signature: "", redacted: [] })
        parts.push({ type: "tool-params-start", id: call.toolUseId, name: call.name })
      }
      if (event.contentBlockDelta !== undefined) {
        const { contentBlockIndex: index, delta } = event.contentBlockDelta
        if (index === undefined || delta === undefined) return yield* failure("Invalid Bedrock content delta")
        let block = this.blocks.get(index)
        const type = delta.toolUse !== undefined ? "tool" : delta.reasoningContent !== undefined ? "reasoning" : delta.text !== undefined ? "text" : undefined
        if (type === undefined) return yield* failure("Unsupported Bedrock content delta")
        if (block === undefined) {
          if (type === "tool") return yield* failure("Bedrock tool delta has no block start")
          block = { type, id: String(index), text: "", signature: "", redacted: [] }
          this.blocks.set(index, block)
          parts.push({ type: type === "text" ? "text-start" : "reasoning-start", id: block.id })
        }
        if (block.type !== type) return yield* failure("Bedrock content block changed type")
        const text = delta.text ?? delta.toolUse?.input ?? delta.reasoningContent?.text ?? ""
        block.text += text
        block.signature += delta.reasoningContent?.signature ?? ""
        if (delta.reasoningContent?.redactedContent !== undefined) for (const byte of delta.reasoningContent.redactedContent) block.redacted.push(byte)
        if (text !== "") parts.push({ type: type === "tool" ? "tool-params-delta" : type === "text" ? "text-delta" : "reasoning-delta", id: block.id, delta: text })
      }
      if (event.contentBlockStop !== undefined) {
        const index = event.contentBlockStop.contentBlockIndex
        const block = index === undefined ? undefined : this.blocks.get(index)
        if (block === undefined) return yield* failure("Bedrock stopped an unknown block")
        this.blocks.delete(index!)
        if (block.type === "tool") { this.calls.set(index!, block); parts.push({ type: "tool-params-end", id: block.id }) }
        else if (block.type === "text") parts.push({ type: "text-end", id: block.id })
        else parts.push({ type: "reasoning-end", id: block.id, metadata: { bedrock: { ...(block.signature === "" ? {} : { signature: block.signature }), ...(block.redacted.length === 0 ? {} : { redactedContent: Encoding.encodeBase64(Uint8Array.from(block.redacted)) }) } } })
      }
      if (event.messageStop !== undefined) {
        if (this.blocks.size !== 0) return yield* failure("Bedrock stopped with unfinished blocks")
        this.stop = event.messageStop.stopReason
      }
      if (event.metadata !== undefined) {
        if (this.stop === undefined) return yield* failure("Bedrock usage arrived before message completion")
        const reason = stopReason(this.stop)
        if (reason === "stop" || reason === "tool-calls") for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
          const params = yield* Effect.try({ try: () => Tool.unsafeSecureJsonParse(call.text === "" ? "{}" : call.text), catch: providerError })
          const tool = this.tools.find((tool) => tool.name === call.name)
          if (tool === undefined) return yield* AiError.make({ module: "BedrockLanguageModel", method: "streamText", reason: AiError.ToolNotFoundError.make({ toolName: call.name!, availableTools: this.tools.map((tool) => tool.name) }) })
          parts.push({ type: "tool-call", id: call.id, name: tool.name, params })
        }
        const usage = event.metadata.usage
        const usageMetadata = usage === undefined ? {} : { usage: yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(JSON.parse(JSON.stringify(usage))).pipe(Effect.mapError(providerError)) }
        parts.push({ type: "finish", reason, usage: { inputTokens: { total: usage?.inputTokens === undefined ? undefined : usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0), cacheRead: usage?.cacheReadInputTokens, cacheWrite: usage?.cacheWriteInputTokens, uncached: usage?.inputTokens }, outputTokens: { total: usage?.outputTokens, reasoning: undefined, text: undefined } }, metadata: { bedrock: usageMetadata } })
      }
      return parts
    })
  }
}
const stopReason = (reason: string): Response.FinishReason => {
  switch (reason) {
    case "end_turn": case "stop_sequence": return "stop"
    case "tool_use": return "tool-calls"
    case "max_tokens": case "model_context_window_exceeded": return "length"
    case "guardrail_intervened": case "content_filtered": return "content-filter"
    default: return "unknown"
  }
}

type NativeJson = null | boolean | number | string | NativeJson[] | { [key: string]: NativeJson }
const nativeJson = (value: unknown): NativeJson => JSON.parse(JSON.stringify(Schema.decodeUnknownSync(Schema.Json)(value)))

// abortable cancels the request before awaiting iterator cleanup (providers/bedrock.test.ts).
const abortable = (stream: AsyncIterable<ConverseStreamOutput>, controller: AbortController): AsyncIterable<ConverseStreamOutput> => ({
  [Symbol.asyncIterator]() {
    const iterator = stream[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      return: () => { controller.abort(); return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }) }
    }
  }
})
