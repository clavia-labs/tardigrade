import { Config, Duration, Effect, Redacted, Result } from "effect"
import { overWindow, sent } from "./http"
import type {
  Action,
  AgentMessage,
  InferenceProvider,
  ModelPricing,
  ModelRequest,
  NativeToolSpec,
  ProviderContinuation,
  Usage
} from "../infer"
import { applyRequestOptions, priced } from "../infer"

const ANTHROPIC_MESSAGES_PROTOCOL = "anthropic-messages/v1"

// How much a model thinks before it answers, on the models that take an effort rather than a token
// budget. A model from before adaptive thinking takes `thinkingBudget` instead.
export type ThinkingEffort = "low" | "medium" | "high"

export interface AnthropicMessagesOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  // What the model accepts. A provider holds this before it exists, so `state` is a constant and the
  // folds that read it agree in every process.
  readonly contextWindow: number
  readonly endpoint: string
  // The ceiling on one answer, which this API requires in every request. It is required here for the
  // same reason the context window is: the number belongs to the model, and a figure invented here
  // would be wrong for every model it was not measured against. A ceiling set low enough to be safe
  // everywhere cuts a long answer short on the models that could have finished it.
  readonly maxOutputTokens: number
  // The key is a `Config` rather than a string, so it is read where it is used and stays redacted on
  // the way there.
  readonly apiKey?: Config.Config<Redacted.Redacted<string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly configurationError?: string
  readonly retries?: number
  readonly timeout?: Duration.Input
  // Thinking, in the two shapes the model generations take. Absent leaves the model's own default,
  // which on the current models already thinks and already returns the state that proves it.
  readonly effort?: ThinkingEffort
  readonly thinkingBudget?: number
  // Fields an endpoint understands that the Messages API does not define. A gateway in front of this
  // API takes routing options here, so this file holds no vendor's routing vocabulary.
  readonly body?: Readonly<Record<string, unknown>>
  readonly pricing?: ModelPricing
}

interface ContentBlock {
  readonly type?: unknown
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: unknown
  readonly [key: string]: unknown
}

interface MessagesResponse {
  readonly content?: ReadonlyArray<ContentBlock>
  readonly stop_reason?: unknown
  readonly usage?: {
    readonly input_tokens?: unknown
    readonly output_tokens?: unknown
    readonly cache_read_input_tokens?: unknown
    readonly cache_creation_input_tokens?: unknown
  }
  readonly error?: { readonly message?: unknown }
}

const tool = (spec: NativeToolSpec) => ({
  name: spec.name,
  description: spec.description,
  input_schema: spec.inputSchema
})

// The blocks the adapter does not rebuild from the log. Thinking blocks and their signatures live
// here, and so does any block type this file has never heard of, which is what keeps a later model
// from needing a change to this list.
const RECONSTRUCTED = new Set(["text", "tool_use"])

const continuationOf = (
  content: ReadonlyArray<ContentBlock>
): ProviderContinuation | undefined => {
  const blocks = content.filter((block) => !RECONSTRUCTED.has(String(block.type)))
  if (blocks.length === 0) return undefined
  return { protocol: ANTHROPIC_MESSAGES_PROTOCOL, value: { blocks } }
}

const carriedBlocks = (
  continuation: ProviderContinuation | undefined
): ReadonlyArray<unknown> => {
  if (continuation?.protocol !== ANTHROPIC_MESSAGES_PROTOCOL) return []
  const value = continuation.value
  if (typeof value !== "object" || value === null) return []
  const blocks = (value as { readonly blocks?: unknown }).blocks
  return Array.isArray(blocks) ? blocks : []
}

// This API takes a tool call's input as a value rather than as the string the OpenAI-compatible
// format uses, so the recorded arguments are read back here. A string that will not parse is a
// broken record: sending an empty object in its place would call the tool with none of what the
// model asked for, and the tool would answer the wrong question with no sign anything was lost.
const BAD_ARGUMENTS = Symbol("arguments that are not JSON")

const parsedArguments = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return BAD_ARGUMENTS
  }
}

interface Entry {
  readonly role: "user" | "assistant"
  readonly content: ReadonlyArray<unknown>
}

// One agent message becomes the blocks this API expects. A thinking block has to arrive before the
// text and the call it belongs to, so the carried blocks lead.
const entryOf = (one: AgentMessage): Entry | undefined => {
  if (one.role === "assistant") {
    const text = one.content ?? ""
    const content = [
      ...carriedBlocks(one.continuation),
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...(one.toolCalls ?? []).map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parsedArguments(call.arguments)
      }))
    ]
    // An assistant turn with nothing in it is not a turn this API accepts, and it carries nothing a
    // later turn could read.
    return content.length === 0 ? undefined : { role: "assistant", content }
  }
  if (one.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: one.toolCallId ?? "",
          content: one.content ?? ""
        }
      ]
    }
  }
  // A system message that arrives mid-conversation is a nudge. This API takes its system prompt at
  // the top level, so the nudge reaches the model as the user turn it sits beside.
  const text = one.content ?? ""
  return text === "" ? undefined : { role: "user", content: [{ type: "text", text }] }
}

// Roles alternate on this API, and the renderer emits a tool result and a nudge as two messages.
// Joining neighbours that share a role keeps the conversation this side sends legal without moving
// the decision about what to say into the renderer.
const joined = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> =>
  entries.reduce<Array<Entry>>((all, entry) => {
    const last = all[all.length - 1]
    if (last?.role === entry.role) {
      all[all.length - 1] = { role: last.role, content: [...last.content, ...entry.content] }
      return all
    }
    all.push(entry)
    return all
  }, [])

const messagesOf = (request: ModelRequest) => {
  const entries = request.messages.flatMap((one) => {
    const entry = entryOf(one)
    return entry === undefined ? [] : [entry]
  })
  const broken = entries
    .flatMap((entry) => entry.content)
    .find((block) => (block as { readonly input?: unknown }).input === BAD_ARGUMENTS)
  if (broken !== undefined) {
    return { name: String((broken as { readonly name?: unknown }).name ?? "") }
  }
  return { messages: joined(entries) }
}

const usageOf = (usage: MessagesResponse["usage"]): Usage => {
  const count = (value: unknown) => (typeof value === "number" ? value : 0)
  return {
    // What the model read, whether or not a cache served it. A turn that reads from cache reads the
    // same conversation, so counting only the uncached part would report a context that shrank.
    promptTokens:
      count(usage?.input_tokens) +
      count(usage?.cache_read_input_tokens) +
      count(usage?.cache_creation_input_tokens),
    completionTokens: count(usage?.output_tokens)
  }
}

const actionOf = (body: MessagesResponse): Action => {
  const failure = body.error?.message
  if (failure !== undefined) return { kind: "fail", error: String(failure) }
  const content = body.content
  if (content === undefined) {
    return { kind: "fail", error: "the inference gateway returned no content" }
  }
  const usage = usageOf(body.usage)
  // An answer stopped at the ceiling is a fragment wearing the shape of an answer, and the tokens
  // were spent either way.
  if (body.stop_reason === "max_tokens") {
    return {
      kind: "fail",
      error:
        "the model stopped at its output-token limit, so its answer is incomplete. Raise " +
        "maxOutputTokens on the provider, or ask for a shorter answer.",
      usage
    }
  }
  const calls = content.filter((block) => block.type === "tool_use")
  if (calls.length > 1) {
    return {
      kind: "fail",
      error:
        "the inference gateway returned multiple tool calls, but this agent executes one call at " +
        "a time. This request asked for one call at a time, so the route that served it does not " +
        "honour that setting. Amazon Bedrock is one such route. Name the providers that may serve " +
        "this model with the routes option to reach one that does.",
      usage
    }
  }
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
  const continuation = continuationOf(content)
  const call = calls[0]
  if (call !== undefined) {
    if (typeof call.id !== "string" || typeof call.name !== "string") {
      return { kind: "fail", error: "the inference gateway returned a malformed tool call", usage }
    }
    return {
      kind: "call",
      callId: call.id,
      name: call.name,
      arguments: call.input ?? {},
      ...(text === "" ? {} : { text }),
      ...(continuation === undefined ? {} : { continuation }),
      usage
    }
  }
  return {
    kind: "complete",
    output: text,
    ...(continuation === undefined ? {} : { continuation }),
    usage
  }
}

export const anthropicMessagesInference = (
  options: AnthropicMessagesOptions
): InferenceProvider => ({
  id: options.id,
  state: () => ({
    provider: options.provider,
    model: options.model,
    contextWindow: options.contextWindow,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing })
  }),
  react: (request: ModelRequest, key: string) =>
    Effect.gen(function* () {
      if (options.configurationError !== undefined) {
        return { kind: "fail", error: options.configurationError } satisfies Action
      }
      const secret = yield* Effect.result(options.apiKey ?? Config.succeed(Redacted.make("")))
      if (Result.isFailure(secret)) {
        return {
          kind: "fail",
          error:
            `${options.provider} could not read its API key: ${String(secret.failure)}. ` +
            "Set it in the environment or pass apiKey when constructing the provider."
        } satisfies Action
      }
      return yield* reacted(options, request, key, Redacted.value(secret.success))
    })
})

const reacted = (
  options: AnthropicMessagesOptions,
  request: ModelRequest,
  key: string,
  secret: string
) => {
  const converted = messagesOf(request)
  if (converted.messages === undefined) {
    return Effect.succeed({
      kind: "fail",
      error:
        `the recorded arguments for the ${converted.name} call are not JSON, so this turn can not ` +
        "be replayed. The log holds what the model asked for, and sending an empty input in its " +
        "place would call the tool with none of it."
    } satisfies Action)
  }
  const body = JSON.stringify(
    applyRequestOptions(
      {
        model: options.model,
        max_tokens: options.maxOutputTokens,
        ...(request.system === "" ? {} : { system: request.system }),
        messages: converted.messages,
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map(tool),
              // One call at a time, because the harness answers one at a time and this API requires a
              // result for every call before the conversation continues.
              tool_choice: { type: "auto", disable_parallel_tool_use: true }
            }),
        ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
        ...(options.thinkingBudget === undefined
          ? {}
          : { thinking: { type: "enabled", budget_tokens: options.thinkingBudget } }),
        ...options.body
      },
      request.options
    )
  )
  const refusal = overWindow(body, options.provider, options.model, options.contextWindow)
  if (refusal !== undefined) return Effect.succeed(refusal)
  return sent({
    call: options.fetch ?? fetch,
    endpoint: options.endpoint,
    headers: {
      // This API reads its key from its own header, and the gateways in front of it also accept a
      // bearer token. Sending both is what lets one adapter serve the API and a gateway.
      "x-api-key": secret,
      authorization: `Bearer ${secret}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "idempotency-key": key,
      ...options.headers
    },
    body,
    provider: options.provider,
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    read: (parsed) => {
      const action = actionOf(parsed as MessagesResponse)
      if (action.usage === undefined) return action
      return { ...action, usage: priced(action.usage, options.pricing) }
    }
  })
}
