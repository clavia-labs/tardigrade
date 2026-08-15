import { Config, Duration, Effect, Redacted, Result, Schedule } from "effect"
import { estimateTextTokens } from "../context"
import type {
  Action,
  AgentMessage,
  InferenceProvider,
  ModelRequest,
  NativeToolSpec,
  Usage
} from "../infer"

export interface OpenAiChatOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
  readonly endpoint: string
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

interface ChatToolCall {
  readonly id?: unknown
  readonly function?: { readonly name?: unknown; readonly arguments?: unknown }
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{
    // Why the model stopped. A gateway that ran out of completion tokens says so here and returns
    // the fragment it had, which is the one failure that looks exactly like an answer.
    readonly finish_reason?: unknown
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

const tool = (spec: NativeToolSpec) => ({
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
        "the model stopped at its completion-token limit, so its answer is incomplete. Raise the " +
        "model's completion-token limit, or ask for a shorter answer.",
      usage
    }
  }
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

// The one maximum a provider states: how large a request the model accepts. It is a bound on the
// whole request rather than on any one message, so this is where it is checked, and nothing upstream
// invents a per-message limit to approximate it.
//
// A request past the window can not succeed, so sending it buys a slow refusal in the gateway's
// words. Refusing here spends nothing and answers in the harness's own words, naming both numbers
// and the setting that decides one of them. `contextWindow` falls back to a built-in figure when
// nothing configures it, and that figure already decides when compaction fires, so a model with a
// larger window meets its assumption here rather than by quietly compacting early.
const overWindow = (body: string, options: OpenAiChatOptions): Action | undefined => {
  const estimate = estimateTextTokens(body)
  if (estimate <= options.contextWindow) return undefined
  return {
    kind: "fail",
    error:
      `this request is at least ${estimate} tokens and ${options.provider} is configured for a ` +
      `context window of ${options.contextWindow} tokens, so the model can not read it. Set ` +
      "contextWindow on the provider when the model accepts more, bound what reaches the model " +
      "with messageTruncateAt and resultTruncateAt, or send less."
  }
}

// A failure worth another attempt: the connection broke, or the gateway is busy or briefly unwell.
// A refusal is not one of these. A request refused for a bad key or a malformed body is refused the
// same way every time, so retrying it spends money and time to learn nothing.
interface Transient {
  readonly reason: string
}

const RETRYABLE = new Set([408, 409, 425, 429])

const isTransient = (status: number) => status >= 500 || RETRYABLE.has(status)

const DEFAULT_RETRIES = 2
const DEFAULT_TIMEOUT: Duration.Input = "60 seconds"

// Waiting longer each time is what makes a retry useful to a gateway that is shedding load, and the
// jitter is what stops a fleet of agents that failed together from returning together.
const backoff = Schedule.exponential("500 millis").pipe(Schedule.jittered)

export const openAiChatInference = (options: OpenAiChatOptions): InferenceProvider => ({
  id: options.id,
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
      const secret = yield* Effect.result(
        options.apiKey ?? Config.succeed(Redacted.make(""))
      )
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

// The request, its retries, and the one outcome they settle on.
const reacted = (
  options: OpenAiChatOptions,
  request: ModelRequest,
  key: string,
  authorization: string
) => {
  const call = options.fetch ?? fetch
  const body = JSON.stringify({
    model: options.model,
    messages: [
      ...(request.system === "" ? [] : [{ role: "system", content: request.system }]),
      ...request.messages.map(message)
    ],
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(tool) })
  })
  const failed = (reason: string): Transient => ({ reason })
  const refusal = overWindow(body, options)
  if (refusal !== undefined) return Effect.succeed(refusal)
  const attempt = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        call(options.endpoint, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            // Every attempt carries the same key, so a retry after a reply this side never saw is
            // the same call to the gateway rather than a second one.
            "idempotency-key": key,
            ...options.headers
          },
          body
        }),
      catch: (error) => failed(error instanceof Error ? error.message : String(error))
    })
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => failed(error instanceof Error ? error.message : String(error))
    })
    if (!response.ok) {
      const reason = `${options.provider} returned HTTP ${response.status}: ${text}`
      if (isTransient(response.status)) return yield* Effect.fail(failed(reason))
      return { kind: "fail", error: reason } satisfies Action
    }
    try {
      return actionOf(JSON.parse(text) as ChatResponse)
    } catch {
      return {
        kind: "fail",
        error: `${options.provider} returned a body that is not JSON: ${text}`
      } satisfies Action
    }
  })
  return attempt.pipe(
    // The bound is on one attempt rather than the whole retry, so a gateway that accepts a
    // request and then goes quiet costs one timeout rather than the turn.
    Effect.timeoutOrElse({
      duration: options.timeout ?? DEFAULT_TIMEOUT,
      orElse: () => Effect.fail(failed("no response within the request timeout"))
    }),
    Effect.retry({ schedule: backoff, times: options.retries ?? DEFAULT_RETRIES }),
    // A failure that outlived its retries becomes the turn's evidence. The inference module reads
    // it, and the log carries what happened.
    Effect.catch((failure) =>
      Effect.succeed({
        kind: "fail",
        error: `${options.provider} request failed: ${failure.reason}`
      } satisfies Action)
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed({
        kind: "fail",
        error: `${options.provider} request failed: ${String(defect)}`
      } satisfies Action)
    )
  )
}
