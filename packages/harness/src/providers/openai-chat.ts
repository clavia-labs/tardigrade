import { Effect } from "effect"
import type {
  Action,
  AgentMessage,
  InferenceProvider,
  ModelRequest,
  ToolSpec,
  Usage
} from "../infer"

export interface OpenAiChatOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
  readonly endpoint: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof fetch
  readonly configurationError?: string
}

interface ChatToolCall {
  readonly id?: unknown
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown }
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: unknown
      readonly tool_calls?: ReadonlyArray<ChatToolCall>
    }
  }>
  readonly usage?: {
    readonly prompt_tokens?: unknown
    readonly completion_tokens?: unknown
    readonly cost?: unknown
    readonly cost_usd?: unknown
  }
  readonly error?: { readonly message?: unknown }
}

const tool = (spec: ToolSpec) => ({
  type: "function" as const,
  function: {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema
  }
})

const message = (one: AgentMessage) =>
  one.role === "assistant" && one.toolCalls !== undefined
    ? {
        role: one.role,
        content: one.content,
        tool_calls: one.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }))
      }
    : one.role === "tool"
      ? { role: one.role, content: one.content, tool_call_id: one.toolCallId }
      : { role: one.role, content: one.content }

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

const actionOf = (body: ChatResponse): Action => {
  const failure = body.error?.message
  if (failure !== undefined) return { kind: "fail", error: String(failure) }
  const answer = body.choices?.[0]?.message
  if (answer === undefined) return { kind: "fail", error: "the inference gateway returned no choice" }
  const usage = usageOf(body.usage)
  const call = answer.tool_calls?.[0]
  if (call !== undefined) {
    const name = call.function?.name
    const id = call.id
    if (typeof name !== "string" || typeof id !== "string") {
      return { kind: "fail", error: "the inference gateway returned a malformed tool call", usage }
    }
    return {
      kind: "call",
      callId: id,
      name,
      arguments: argumentsOf(call.function?.arguments),
      text: typeof answer.content === "string" ? answer.content : undefined,
      usage
    }
  }
  return {
    kind: "complete",
    output: typeof answer.content === "string" ? answer.content : "",
    usage
  }
}

export const openAiChatInference = (options: OpenAiChatOptions): InferenceProvider => ({
  id: options.id,
  state: () => ({
    provider: options.provider,
    model: options.model,
    contextWindow: options.contextWindow
  }),
  react: (request: ModelRequest, key: string) => {
    if (options.configurationError !== undefined) {
      return Effect.succeed({ kind: "fail", error: options.configurationError } satisfies Action)
    }
    const call = options.fetch ?? fetch
    return Effect.tryPromise({
      try: async () => {
        const response = await call(options.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey ?? ""}`,
            "content-type": "application/json",
            "idempotency-key": key,
            ...options.headers
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              ...(request.system === "" ? [] : [{ role: "system", content: request.system }]),
              ...request.messages.map(message)
            ],
            ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool) })
          })
        })
        const text = await response.text()
        if (!response.ok) {
          return {
            kind: "fail",
            error: `${options.provider} returned HTTP ${response.status}: ${text}`
          } satisfies Action
        }
        return actionOf(JSON.parse(text) as ChatResponse)
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error)))
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          kind: "fail",
          error: `${options.provider} request failed: ${error.message}`
        } satisfies Action)
      ),
      Effect.catchAllDefect((defect) =>
        Effect.succeed({
          kind: "fail",
          error: `${options.provider} request failed: ${String(defect)}`
        } satisfies Action)
      )
    )
  }
})
