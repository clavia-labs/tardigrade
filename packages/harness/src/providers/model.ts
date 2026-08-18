import { APICallError, generateText, jsonSchema, tool, type LanguageModel, type ModelMessage } from "ai"
import type { AssistantContent, ToolSet } from "ai"
import type { ProviderOptions } from "@ai-sdk/provider-utils"
import { Duration, Effect } from "effect"
import {
  priced,
  requestTokens,
  type Action,
  type AgentMessage,
  type InferenceProvider,
  type ModelPricing,
  type ModelRequest,
  type NativeToolSpec,
  type Effort,
  type ProviderContinuation,
  type Usage
} from "../infer"

// One adapter for every model this framework talks to. The AI SDK owns the wire format, so the
// difference between a Claude model that returns signed thinking blocks and a GPT model that returns
// reasoning items is the SDK's problem rather than this package's. What is left here is the part the
// SDK has no opinion about: which failures earn another attempt, which earn a journaled wait, and
// what a turn records about what it spent.
//
// A hand-written adapter per wire format was the alternative, and it cost one dialect per field. An
// effort level reached the Messages API as `output_config` and the chat API as `reasoning_effort`,
// so a setting written once was right in one place and silently wrong in the other. The SDK
// normalizes that vocabulary across providers, which is why the setting can be named once.

// The continuation protocol. The value is the assistant content the SDK returned, carried whole:
// reasoning parts hold provider state in `providerOptions`, and a part this build has never met
// travels with the rest rather than being dropped for being unrecognized.
const PROTOCOL = "ai-sdk/v1"

export interface TransportOptions {
  readonly headers?: Readonly<Record<string, string>>
  // How many further attempts a transient failure earns before the turn journals a wait, and how
  // long one attempt may take.
  readonly retries?: number
  readonly timeout?: Duration.Input
  // The ceiling on one answer. Absent leaves it to the provider's own default for the model, which
  // is right until a turn asks for a long generated artifact.
  readonly maxOutputTokens?: number
  readonly temperature?: number
  // How much the model thinks before it answers, as a default for every request. A per-request
  // projection overrides it.
  readonly reasoning?: Effort
  // Provider vocabulary, typed and attributed to the provider that reads it. Gateway routing lives
  // here under the `gateway` key.
  readonly providerOptions?: ProviderOptions
}

export interface ModelInferenceOptions extends TransportOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  // What the model accepts. A provider holds this before it exists, so `state` is a constant and the
  // folds that read it agree in every process.
  readonly contextWindow: number
  readonly pricing?: ModelPricing
  readonly languageModel: LanguageModel
  readonly configurationError?: string
}

// A request past the window can not succeed, so sending it buys a slow refusal in the gateway's
// words. Refusing here spends nothing and answers in the harness's own words, naming both sizes and
// the model they belong to.
//
// The window bounds what the model reads and what it writes together, so the ceiling on the answer
// is reserved against it. A check on the prompt alone passes a request the provider then refuses,
// naming a total this side never mentioned.
export const windowError = (
  estimate: number,
  provider: string,
  model: string,
  window: number,
  reservedOutput = 0
) =>
  `this request is at least ${estimate} tokens` +
  (reservedOutput > 0 ? ` plus ${reservedOutput} reserved for the answer` : "") +
  ` and ${provider} reports a context window of ${window} tokens for ${model}, so the model can ` +
  "not read it. Pass contextWindow to override what the model accepts, bound what reaches the " +
  "model with messageTruncateAt and resultTruncateAt, or send less."

export const overWindow = (
  request: ModelRequest,
  provider: string,
  model: string,
  window: number,
  reservedOutput = 0
): Action | undefined => {
  const estimate = requestTokens(request)
  if (estimate + reservedOutput <= window) return undefined
  return {
    kind: "fail",
    error: windowError(estimate, provider, model, window, reservedOutput)
  }
}

// How long one attempt may take before this side stops waiting. It guards a socket that has gone
// quiet, so it sits well outside the range where real answers land: a reasoning model thinking for
// two minutes is working, and a connection silent for ten is hung.
const DEFAULT_TIMEOUT: Duration.Input = "10 minutes"

const DEFAULT_RETRIES = 2

// A Retry-After of more than two seconds is a queue, not a blip. Waiting it out inside this Effect
// would hold the turn open, and a crash would lose the wait. Returning it on the action lets the log
// record the due time and the runtime wake the session.
const QUEUE_RETRY_AFTER_MS = 2_000

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

// `Retry-After` in both forms the specification allows: a count of seconds, or a date to wait until.
const retryAfterMsOf = (headers: Readonly<Record<string, string>> | undefined, now: number) => {
  const header = headers?.["retry-after"]
  if (header === undefined || header === "") return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  if (Number.isFinite(at)) return Math.max(0, at - now)
  return undefined
}

const continuationOf = (content: AssistantContent): ProviderContinuation | undefined =>
  typeof content === "string" || content.length === 0
    ? undefined
    : { protocol: PROTOCOL, value: { content } }

const carriedContent = (continuation: ProviderContinuation | undefined): AssistantContent | undefined => {
  if (continuation?.protocol !== PROTOCOL) return undefined
  const held = recordOf(continuation.value)?.content
  return Array.isArray(held) && held.length > 0 ? (held as AssistantContent) : undefined
}

const parsedArguments = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

// One rendered message becomes one message the SDK understands. An assistant turn prefers the
// content the provider returned, because that is where reasoning state lives and rebuilding it from
// the log would drop the part the log does not describe.
const messageOf = (one: AgentMessage): ModelMessage | undefined => {
  if (one.role === "assistant") {
    const carried = carriedContent(one.continuation)
    if (carried !== undefined) return { role: "assistant", content: carried }
    const text = one.content ?? ""
    const content: AssistantContent = [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...(one.toolCalls ?? []).map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.name,
        input: parsedArguments(call.arguments)
      }))
    ]
    return content.length === 0 ? undefined : { role: "assistant", content }
  }
  if (one.role === "tool") {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: one.toolCallId ?? "",
          toolName: one.toolName ?? "",
          output: { type: "text", value: one.content ?? "" }
        }
      ]
    }
  }
  const text = one.content ?? ""
  if (text === "") return undefined
  // A system message that arrives mid-conversation is a nudge. The system prompt is sent separately,
  // so a nudge reaches the model as the user turn it sits beside.
  return { role: "user", content: text }
}

const toolsOf = (specs: ReadonlyArray<NativeToolSpec>): ToolSet =>
  Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      // No `execute`: the harness dispatches its own tools through the log, so the SDK reports the
      // call and stops rather than running it and hiding the step.
      tool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema as object) })
    ])
  )

// What one call spent, as the SDK counted it and the gateway priced it. Named for the question it
// answers rather than for its shape, because `usageOf` in the alphabet reads a recorded figure and
// this reads a provider's reply.
const spentOn = (
  usage:
    | { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined }
    | undefined,
  metadata: unknown,
  pricing: ModelPricing | undefined
): Usage => {
  const reported = recordOf(recordOf(metadata)?.gateway)?.cost
  const costUsd = Number(reported)
  return priced(
    {
      promptTokens: usage?.inputTokens ?? 0,
      completionTokens: usage?.outputTokens ?? 0,
      // A cost the provider stated, including zero, is the figure. A cost nobody stated is absent,
      // and the price table fills it when there is one.
      ...(reported !== undefined && Number.isFinite(costUsd) ? { costUsd } : {})
    },
    pricing
  )
}

// What the SDK threw, read as one of the three outcomes a turn can record. A refusal is settled: the
// same request refused once is refused again. A busy or unreachable gateway is a wait, and the wait
// goes on the log rather than into a sleep this process would lose.
const failureOf = (error: unknown, provider: string, now: number): Action => {
  if (APICallError.isInstance(error)) {
    const reason =
      `${provider} returned HTTP ${String(error.statusCode ?? "no status")}: ${error.message}`
    if (!error.isRetryable) return { kind: "fail", error: reason }
    const retryAfterMs = retryAfterMsOf(error.responseHeaders, now)
    return {
      kind: "defer",
      error: reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  // An attempt this side stopped waiting for is a wait, not a refusal: the request may well have
  // been served, and the next attempt carries the same idempotency key to find out.
  return { kind: "defer", error: `${provider} request failed: ${message}` }
}

export const modelInference = (options: ModelInferenceOptions): InferenceProvider => ({
  id: options.id,
  // A constant, so the projection folds the same in every process and a replay reaches the verdict
  // the run it replays reached.
  state: () => ({
    provider: options.provider,
    model: options.model,
    contextWindow: options.contextWindow,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
  }),
  react: (request: ModelRequest, key: string) =>
    Effect.gen(function* () {
      if (options.configurationError !== undefined) {
        return { kind: "fail", error: options.configurationError } satisfies Action
      }
      const refusal = overWindow(
        request,
        options.provider,
        options.model,
        options.contextWindow,
        request.options?.maxOutputTokens ?? options.maxOutputTokens ?? 0
      )
      if (refusal !== undefined) return refusal
      return yield* reacted(options, request, key)
    })
})

const reacted = (options: ModelInferenceOptions, request: ModelRequest, key: string) => {
  const per = request.options
  const messages = request.messages.flatMap((one) => {
    const message = messageOf(one)
    return message === undefined ? [] : [message]
  })
  // What this request asks for: the projection's choice where it made one, the provider's own
  // default otherwise, and nothing at all where neither said, so the model's default decides.
  const reasoning = per?.reasoning ?? options.reasoning
  const temperature = per?.temperature ?? options.temperature
  const maxOutputTokens = per?.maxOutputTokens ?? options.maxOutputTokens
  const providerOptions =
    options.providerOptions === undefined && per?.providerOptions === undefined
      ? undefined
      : { ...options.providerOptions, ...per?.providerOptions }
  const settings = {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(providerOptions === undefined ? {} : { providerOptions })
  }
  const call = Effect.tryPromise({
    try: (signal) =>
      generateText({
        model: options.languageModel,
        ...(request.system === "" ? {} : { system: request.system }),
        messages,
        ...(request.tools.length === 0 ? {} : { tools: toolsOf(request.tools) }),
        // The framework owns retry and the journaled wait, so the SDK does neither. Two retry
        // policies over one request would each count attempts the other made.
        maxRetries: 0,
        abortSignal: signal,
        headers: {
          // Every attempt on one call carries the same key, so a retry after a reply this side
          // never saw is the same call to the gateway rather than a second one.
          "idempotency-key": key,
          ...options.headers
        },
        ...settings
      }),
    catch: (error) => error
  })
  return call.pipe(
    // The bound is on one attempt rather than on the retry, so a gateway that accepts a request and
    // then goes quiet costs one timeout rather than the turn. Interruption reaches the gateway
    // through the signal: an attempt that is only stopped being awaited keeps running, the model
    // finishes it, and the provider bills for a turn that recorded a failure.
    Effect.timeoutOrElse({
      duration: options.timeout ?? DEFAULT_TIMEOUT,
      orElse: () => Effect.fail(new Error("no response within the request timeout"))
    }),
    Effect.retry({
      times: options.retries ?? DEFAULT_RETRIES,
      // Only a failure the provider called retryable earns another attempt in flight. A queue long
      // enough to state a Retry-After is journaled instead, so the wait survives a restart.
      while: (error: unknown) =>
        !APICallError.isInstance(error) ||
        (error.isRetryable &&
          (retryAfterMsOf(error.responseHeaders, Date.now()) ?? 0) <= QUEUE_RETRY_AFTER_MS)
    }),
    Effect.map((result) => actionOf(result, options)),
    Effect.catch((error) => Effect.succeed(failureOf(error, options.provider, Date.now()))),
    Effect.catchDefect((defect) =>
      Effect.succeed({
        kind: "fail",
        error: `${options.provider} request failed: ${String(defect)}`
      } satisfies Action)
    )
  )
}

type Generated = Awaited<ReturnType<typeof generateText>>

const actionOf = (result: Generated, options: ModelInferenceOptions): Action => {
  const usage = spentOn(result.usage, result.providerMetadata, options.pricing)
  // An answer stopped at its ceiling is a fragment wearing the shape of an answer. Reading it as one
  // would finish the turn on half a sentence, or dispatch a tool call whose arguments stop mid-JSON.
  // The tokens were spent either way, so the usage rides the action, and the fragment is recorded so
  // the turn continues from it rather than generating the whole artifact again.
  //
  // A tool call cut before its arguments closed is reported as itself. Folding it into the text
  // would mean inventing a notation for a partial call, and the model that reads the conversation
  // back was trained on no such notation. Naming the tool leaves that decision to a module.
  if (result.finishReason === "length") {
    const assistant = result.responseMessages.find((message) => message.role === "assistant")
    const carried = assistant === undefined ? undefined : continuationOf(assistant.content)
    const cut = result.toolCalls[0]
    return {
      kind: "truncated",
      text: result.text,
      ...(cut === undefined
        ? {}
        : { call: { name: cut.toolName, arguments: JSON.stringify(cut.input ?? {}) } }),
      ...(carried === undefined ? {} : { continuation: carried }),
      usage
    }
  }
  if (result.toolCalls.length > 1) {
    return {
      kind: "fail",
      error:
        "the inference gateway returned multiple tool calls, but this agent executes one call at " +
        "a time. The route that served this request does not honour that setting. Amazon Bedrock " +
        "is one such route. Name the providers that may serve this model with the routes option to " +
        "reach one that does.",
      usage
    }
  }
  // Only an outcome the conversation continues from carries state forward, so it is read here rather
  // than above the two failures that would discard it.
  const assistant = result.responseMessages.find((message) => message.role === "assistant")
  const continuation = assistant === undefined ? undefined : continuationOf(assistant.content)
  const called = result.toolCalls[0]
  if (called !== undefined) {
    return {
      kind: "call",
      callId: called.toolCallId,
      name: called.toolName,
      arguments: called.input,
      ...(result.text === "" ? {} : { text: result.text }),
      ...(continuation === undefined ? {} : { continuation }),
      usage
    }
  }
  return {
    kind: "complete",
    output: result.text,
    ...(continuation === undefined ? {} : { continuation }),
    usage
  }
}
