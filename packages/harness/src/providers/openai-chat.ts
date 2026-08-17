import { Config, Duration, Effect, Redacted, Result } from "effect"
import { overWindow, sent } from "./http"
import type {
  Action,
  AgentMessage,
  InferenceProvider,
  ModelRequest,
  NativeToolSpec,
  ProviderContinuation,
  Usage
} from "../infer"

const OPENAI_CHAT_PROTOCOL = "openai-chat-completions/v1"

export interface OpenAiChatOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  // What the model accepts. A provider holds this before it exists, so `state` is a constant and the
  // folds that read it agree in every process. A constructor that has to ask a gateway asks before
  // it builds one.
  readonly contextWindow: number
  readonly endpoint: string
  // The ceiling on one answer, in completion tokens. See `TransportOptions`.
  readonly maxOutputTokens?: number
  // The key is a `Config` rather than a string, so it is read where it is used and stays redacted
  // on the way there. A value that never becomes a plain string can not be printed by an error
  // report or a log line that happened to hold the options.
  readonly apiKey?: Config.Config<Redacted.Redacted<string>>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly configurationError?: string
  // How many further attempts a transient failure earns, and how long one attempt may take.
  readonly retries?: number
  readonly timeout?: Duration.Input
}

// What a gateway forwards rather than fixes. Every gateway built on this provider takes the same
// settings, and one that swallowed them would leave a caller reimplementing the whole provider to
// change one number, which is what a gateway in front of a slow model needs to do.
export interface TransportOptions {
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly retries?: number
  readonly timeout?: Duration.Input
  // The ceiling on one answer, in completion tokens. Absent leaves it to the gateway's own default
  // for the model, which is the right answer until a turn asks for a long generated artifact. A
  // default sized for chat can cut that artifact off partway through.
  readonly maxOutputTokens?: number
}

export const transport = (options: TransportOptions) => ({
  ...(options.headers === undefined ? {} : { headers: options.headers }),
  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  ...(options.retries === undefined ? {} : { retries: options.retries }),
  ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
})

interface ChatToolCall {
  readonly id?: unknown
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown }
  readonly [key: string]: unknown
}

interface ChatMessage {
  readonly content?: unknown
  readonly tool_calls?: ReadonlyArray<ChatToolCall>
  readonly [key: string]: unknown
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{
    // Why the model stopped. A gateway that ran out of completion tokens says so here and returns
    // the fragment it had, which is the one failure that looks exactly like an answer.
    readonly finish_reason?: unknown
    readonly message?: ChatMessage
  }>
  readonly usage?: {
    readonly prompt_tokens?: unknown
    readonly completion_tokens?: unknown
    readonly cost?: unknown
    readonly cost_usd?: unknown
  }
  readonly error?: { readonly message?: unknown }
}

const tool = (spec: NativeToolSpec) => ({
  type: "function" as const,
  function: {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema
  }
})

interface OpenAiContinuation {
  readonly message?: Readonly<Record<string, unknown>>
  readonly toolCall?: Readonly<Record<string, unknown>>
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const extrasOf = (
  source: Readonly<Record<string, unknown>>,
  reserved: ReadonlySet<string>
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(source).filter(([name]) => !reserved.has(name)))

const openAiContinuationOf = (
  continuation: ProviderContinuation | undefined
): OpenAiContinuation => {
  if (continuation?.protocol !== OPENAI_CHAT_PROTOCOL) return {}
  const value = recordOf(continuation.value)
  if (value === undefined) return {}
  const message = recordOf(value.message)
  const toolCall = recordOf(value.toolCall)
  return {
    ...(message === undefined ? {} : { message }),
    ...(toolCall === undefined ? {} : { toolCall })
  }
}

const message = (one: AgentMessage) => {
  if (one.role === "assistant") {
    const continuation = openAiContinuationOf(one.continuation)
    return one.toolCalls === undefined
      ? { ...continuation.message, role: one.role, content: one.content }
      : {
          ...continuation.message,
          role: one.role,
          content: one.content,
          tool_calls: one.toolCalls.map((call) => ({
            ...continuation.toolCall,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments }
          }))
        }
  }
  return one.role === "tool"
    ? { role: one.role, content: one.content, tool_call_id: one.toolCallId }
    : { role: one.role, content: one.content }
}

const usageOf = (usage: ChatResponse["usage"]): Usage => ({
  promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
  completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
  costUsd:
    typeof usage?.cost_usd === "number"
      ? usage.cost_usd
      : typeof usage?.cost === "number"
        ? usage.cost
        : 0
})

const argumentsOf = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const continuationOf = (
  answer: ChatMessage,
  call: ChatToolCall | undefined
): ProviderContinuation | undefined => {
  // Provider metadata describes routing and billing after the call. Conversation input excludes
  // it. Every other extension stays with the assistant message, where reasoning transports place
  // the state that a later request must return.
  const message = extrasOf(
    answer,
    new Set(["role", "content", "tool_calls", "provider_metadata", "providerMetadata"])
  )
  const toolCall = call === undefined
    ? {}
    : extrasOf(call, new Set(["id", "type", "function"]))
  if (Object.keys(message).length === 0 && Object.keys(toolCall).length === 0) return undefined
  return {
    protocol: OPENAI_CHAT_PROTOCOL,
    value: {
      ...(Object.keys(message).length === 0 ? {} : { message }),
      ...(Object.keys(toolCall).length === 0 ? {} : { toolCall })
    }
  }
}

const actionOf = (body: ChatResponse): Action => {
  const failure = body.error?.message
  if (failure !== undefined) return { kind: "fail", error: String(failure) }
  const choice = body.choices?.[0]
  const answer = choice?.message
  if (answer === undefined) return { kind: "fail", error: "the inference gateway returned no choice" }
  const usage = usageOf(body.usage)
  // A response the gateway stopped at the completion-token limit is a fragment wearing the shape of
  // an answer. Reading it as one is the silent failure this catches: the turn would complete on half
  // a sentence, or dispatch a tool call whose arguments stop mid-JSON and parse as a bare string.
  // The tokens were spent either way, so the usage rides the failure and the turn's cost stays true.
  if (choice?.finish_reason === "length") {
    return {
      kind: "fail",
      error:
        "the model stopped at its completion-token limit, so its answer is incomplete. Raise " +
        "maxOutputTokens on the provider, or ask for a shorter answer.",
      usage
    }
  }
  const calls = answer.tool_calls ?? []
  if (calls.length > 1) {
    return {
      kind: "fail",
      error: "the inference gateway returned multiple tool calls, but this agent executes one call at a time",
      usage
    }
  }
  const call = calls[0]
  if (call !== undefined) {
    const name = call.function?.name
    const id = call.id
    if (typeof name !== "string" || typeof id !== "string") {
      return { kind: "fail", error: "the inference gateway returned a malformed tool call", usage }
    }
    const continuation = continuationOf(answer, call)
    return {
      kind: "call",
      callId: id,
      name,
      arguments: argumentsOf(call.function?.arguments),
      text: typeof answer.content === "string" ? answer.content : undefined,
      ...(continuation === undefined ? {} : { continuation }),
      usage
    }
  }
  const continuation = continuationOf(answer, undefined)
  return {
    kind: "complete",
    output: typeof answer.content === "string" ? answer.content : "",
    ...(continuation === undefined ? {} : { continuation }),
    usage
  }
}

export const openAiChatInference = (options: OpenAiChatOptions): InferenceProvider => ({
  id: options.id,
  // A constant, so the projection folds the same in every process and a replay reaches the verdict
  // the run it replays reached.
  state: () => ({
    provider: options.provider,
    model: options.model,
    contextWindow: options.contextWindow
  }),
  react: (request: ModelRequest, key: string) =>
    Effect.gen(function* () {
      if (options.configurationError !== undefined) {
        return { kind: "fail", error: options.configurationError } satisfies Action
      }
      // A key that can not be read is a terminal failure rather than a transient one, so it is
      // settled before the attempt rather than retried inside it.
      const secret = yield* Effect.result(options.apiKey ?? Config.succeed(Redacted.make("")))
      if (Result.isFailure(secret)) {
        return {
          kind: "fail",
          error:
            `${options.provider} could not read its API key: ${String(secret.failure)}. ` +
            "Set it in the environment or pass apiKey when constructing the provider."
        } satisfies Action
      }
      const authorization = `Bearer ${Redacted.value(secret.success)}`
      return yield* reacted(options, request, key, authorization)
    })
})

const reacted = (
  options: OpenAiChatOptions,
  request: ModelRequest,
  key: string,
  authorization: string
) => {
  const body = JSON.stringify({
    model: options.model,
    messages: [
      ...(request.system === "" ? [] : [{ role: "system", content: request.system }]),
      ...request.messages.map(message)
    ],
    ...(options.maxOutputTokens === undefined
      ? {}
      : { max_tokens: options.maxOutputTokens }),
    ...(request.tools.length === 0
      ? {}
      : { tools: request.tools.map(tool), parallel_tool_calls: false })
  })
  const refusal = overWindow(body, options.provider, options.model, options.contextWindow)
  if (refusal !== undefined) return Effect.succeed(refusal)
  return sent({
    call: options.fetch ?? fetch,
    endpoint: options.endpoint,
    headers: {
      authorization,
      "content-type": "application/json",
      // Every attempt carries the same key, so a retry after a reply this side never saw is the
      // same call to the gateway rather than a second one.
      "idempotency-key": key,
      ...options.headers
    },
    body,
    provider: options.provider,
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    read: (parsed) => actionOf(parsed as ChatResponse)
  })
}
