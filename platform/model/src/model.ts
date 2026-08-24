import { Clock, Effect, Layer, Random } from "effect"
import {
  StreamProcessor,
  type ModelMessage,
  type ProcessorResult,
  type StreamChunk,
  type TokenUsage,
  type Tool,
  type ToolCall
} from "@tanstack/ai"
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import { createAnthropicChat } from "@tanstack/ai-anthropic"
import * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime"
import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import { BedrockConverseTextAdapter, type BEDROCK_CONVERSE_MODELS } from "@tanstack/ai-bedrock"
import { Infer, NativeOutputSupport, type InferRequest } from "tardie"
import type { Action, AttemptEndpoint } from "tardie/events"
import { assertSupportedBun } from "@clavia/tardigrade-core/runtime"
import { modelRequest, type AgentMessage, type ModelRequest, type OutputRequest, type ToolSpec } from "tardie/request"
import {
  capabilityOf,
  converseOutputConfig,
  converseStopClass,
  compatibleResponseFormat,
  outputModeOf,
  fallbackSystemFor,
  type OutputCapability
} from "./output"
import { NATIVE_MODE, type OutputMode } from "tardie/output"
import { sumUsage, usageFrom, type ModelPricing, type Usage } from "tardie/usage"
import type { ModelDriver } from "./directory"

// The real model binding: one inference per react, streamed through a TanStack adapter and
// decoded by their StreamProcessor. The reactors never learn this layer exists. Resilience is
// layered: the stream bounds below catch a hung provider inside the call, and the retry ladder
// bounds transient provider failures. Exhaustion returns a failed action with its policy and
// attempt count, so the turn records one resumable `TurnFailed` terminal.

// StreamBounds is time to first chunk, idle between chunks, and the whole stream. Each timeout
// enters the bounded provider retry policy (model.test.ts, "throttle-shaped retry").
export interface StreamBounds {
  readonly firstChunkMs: number
  readonly idleMs: number
  readonly totalMs: number
}

export const DEFAULT_STREAM_BOUNDS: StreamBounds = {
  firstChunkMs: 90_000,
  idleMs: 90_000,
  totalMs: 300_000
}

// MAX_TIMER_DELAY_MS is the largest delay Bun accepts without clamping it to 1ms
// (model.test.ts, "stream bounds").
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const bounded = (stream: AsyncIterable<StreamChunk>, bounds: StreamBounds): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    const startedAt = Date.now()
    const iterator = stream[Symbol.asyncIterator]()
    let first = true
    while (true) {
      const budget = Math.min(first ? bounds.firstChunkMs : bounds.idleMs, bounds.totalMs - (Date.now() - startedAt))
      if (budget <= 0) throw new Error("model stream exceeded its total bound")
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(first ? "no first chunk within bound" : "model stream idle beyond bound")), budget)
      })
      try {
        const next = await Promise.race([iterator.next(), timeout])
        if (next.done) return
        first = false
        // A provider refusal arrives as a RUN_ERROR chunk the processor would silently absorb,
        // leaving an empty result that reads as "the model said nothing". Throw the real cause.
        const chunk = next.value as { type?: unknown; message?: unknown; code?: unknown; error?: { message?: unknown } }
        if (String(chunk.type) === "RUN_ERROR") {
          throw new Error(
            `model stream error: ${String(chunk.message ?? chunk.error?.message ?? "unknown")}${chunk.code === undefined ? "" : ` (${String(chunk.code)})`}`
          )
        }
        yield next.value
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
})

// The provider adapter: map the domain request's messages and tools onto this provider's wire. The
// tool name is sanitized to the strictest alphabet (Converse: [a-zA-Z0-9_-]+) here, a wire concern;
// the log and the domain keep the exact name.
const toMessage = (m: AgentMessage): ModelMessage =>
  ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls === undefined
      ? {}
      : {
          toolCalls: m.toolCalls.map(
            (c): ToolCall => ({ id: c.id, type: "function", function: { name: c.name.replace(/[^a-zA-Z0-9_-]/g, "_"), arguments: c.arguments } })
          )
        }),
    ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId })
  }) as ModelMessage

const toTool = (t: ToolSpec): Tool => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema as NonNullable<Tool["inputSchema"]>
})

// The decode: the processed stream becomes one Action. A tool call acts; the final response
// completes and carries its text verbatim, whether that text is prose or the JSON a native
// schema constrained it to; an empty response enters the provider failure path.
//
// Nothing here judges the response against a contract. The turn's contract is the actor's, and
// the actor validates every completion before it records a terminal (tardie, runtime/infer.ts,
// completionOf), so a strict provider is checked once rather than trusted twice.
export const actionOf = (result: ProcessorResult): Action => {
  const calls = result.toolCalls ?? []
  const text = (result.content ?? "").trim()
  const call = calls.find((c) => c.function.name === "execute") ?? calls[0]
  if (call !== undefined) {
    let args: unknown
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      args = { code: call.function.arguments }
    }
    return {
      kind: "call",
      callId: call.id,
      name: call.function.name,
      arguments: args,
      ...(text === "" ? {} : { text })
    }
  }
  if (text !== "") return { kind: "complete", output: text }
  // A provider that declined leaves neither: content_filter is the finish reason that says so,
  // and a refusal a retry of the same request would only earn again (model.test.ts, "a provider
  // that declined leaves neither text nor a call, and says so").
  if (result.finishReason === "content_filter") {
    throw new RefusedError("the provider refused to answer this request")
  }
  throw new Error("the model produced neither text nor a tool call")
}

// RefusedError marks the one failure the retry ladder must not climb: a provider that declined.
class RefusedError extends Error {
  readonly refused = true
}

// ViolatedError marks a provider breaking a native strict guarantee on its own wire, which
// Converse says outright (output.ts, converseStopClass). The compatible leg reports the same
// class through local validation instead (tardie, runtime/infer.ts, completionOf).
class ViolatedError extends Error {
  readonly violated = true
}

const isRefused = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { refused?: unknown }).refused === true

const isViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { violated?: unknown }).violated === true

const noopLogger = new Proxy({}, { get: () => () => {} }) as never

export interface ModelConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly driver: ModelDriver
  readonly provider: string
  readonly contextWindowTokens: number
  // The model's output ceiling, DECLARED by the operator rather than guessed: no wire this
  // binding speaks publishes limits, so the number that bounds the truncation ladder is stated
  // configuration. Absent, the ladder falls back to its built-in guesses and the compatible leg
  // sends its rung explicitly rather than trusting a provider default.
  readonly maxOutputTokens?: number
  // The rungs the truncation ladder climbs, smallest first. Absent, MAX_TOKENS_LADDER. A model
  // whose useful answers start above the first rung wastes an attempt on every turn, so the
  // rungs are the operator's to state, bounded by `maxOutputTokens` either way (ladderOf).
  readonly maxTokensLadder?: ReadonlyArray<number>
  // Stream wall times. Absent fields take DEFAULT_STREAM_BOUNDS. A long healthy generation
  // that outlives totalMs dies the same way a hung stream does, so set this for the work you run.
  readonly stream?: Partial<StreamBounds>
  // What this endpoint and model promise about a declared output contract. Absent means no
  // promise: a turn that declares a contract fails before spend unless its assembly provides a
  // fallback. A provider name never supplies this value (src/output.ts, capabilityOf).
  readonly output?: OutputCapability
  // pricing projects an estimate beside any provider-reported bill. Reported cache buckets
  // require their own stated rates (packages/agent/src/usage.ts, priced).
  readonly pricing?: ModelPricing
  // In-act backoff bases for throttle-shaped failures. Length is the retry count.
  readonly throttleRetryDelaysMs?: ReadonlyArray<number>
  // retryAfterJitterMs adds a random wait to a provider's Retry-After value. Absent, DEFAULT_RETRY_AFTER_JITTER_MS.
  readonly retryAfterJitterMs?: number
  readonly fetch?: FetchImpl // test seam
  readonly sleep?: (ms: number) => Promise<void> // test seam: swap the backoff wait for an instant one
}

type NativeOutputProvided<C extends ModelConfig> = [C] extends [
  { readonly output: { readonly guarantee: "native"; readonly withTools: true } }
]
  ? NativeOutputSupport
  : never

// Throttle-shaped failures need delayed retries because fan-out can trip a gateway's rate limit.
// The reactor has no timer vocabulary, so the model binding owns these waits inside one act.
// The configured delay list bounds the retries. Exhaustion returns a failed action with the
// effective policy, which lets the turn record a resumable terminal.
//
// The openai SDK client `chatStream` runs on (`@tanstack/openai-base`) throws its `APIError`
// subclasses with a numeric `.status`: 429 is the gateway's rate limit, 5xx is its own upstream
// trouble. `bounded()` below throws plain `Error`s for the same shape of failure (a stream that
// never starts or stalls), so the message is checked too.
export const DEFAULT_THROTTLE_RETRY_DELAYS_MS: ReadonlyArray<number> = [2_000, 8_000, 30_000]
export const DEFAULT_RETRY_AFTER_JITTER_MS = 1_000

const isThrottleShaped = (e: unknown): boolean => {
  const err = e as { status?: unknown; statusCode?: unknown; message?: unknown }
  const status = typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined
  if (status === 429 || (status !== undefined && status >= 500)) return true
  const message = String(err.message ?? e)
  return /\b429\b|rate.?limit|too many requests|\b5\d\d\b|timeout|timed?\s*out|idle beyond bound|exceeded its total bound|no first chunk within bound|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    message
  )
}

// Full jitter (AWS's term for it): a uniform draw between 0 and the base, so many attempts
// throttled at the same instant do not retry in lockstep and re-trip the same limit together.
const jittered = (baseMs: number, nextRandom: () => number): number => nextRandom() * baseMs

// retryAfterMsOf reads the provider's own wait from a thrown failure, in both forms the
// specification allows (a count of seconds, or a date to wait until). The adapters differ in
// where they carry response headers, so every plausible seat is checked; a failure carrying
// none falls back to the jittered ladder. A stated wait beats a guessed one: the provider
// knows its queue (model.test.ts, "retry-after").
const headerOf = (carrier: unknown, name: string): string | undefined => {
  if (carrier === null || typeof carrier !== "object") return undefined
  const h = carrier as { get?: (n: string) => string | null } & Record<string, unknown>
  if (typeof h.get === "function") return h.get(name) ?? undefined
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name)
  return hit === undefined ? undefined : String(hit[1])
}

export const retryAfterMsOf = (e: unknown, now: number): number | undefined => {
  const err = e as { headers?: unknown; responseHeaders?: unknown; cause?: { headers?: unknown } }
  for (const carrier of [err.headers, err.responseHeaders, err.cause?.headers]) {
    const header = headerOf(carrier, "retry-after")
    if (header === undefined || header === "") continue
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const at = Date.parse(header)
    if (Number.isFinite(at)) return Math.max(0, at - now)
  }
  return undefined
}

// throttleDelayMs decides one in-flight wait: the provider's stated Retry-After when it fits
// the ladder's own ceiling (plus the stated jitter, so a herd released together does not re-trip
// the limit), the jittered ladder otherwise, and undefined for a stated wait past the ceiling. A
// stated wait past the ceiling ends the bounded retry set.
export const throttleDelayMs = (
  e: unknown,
  attempt: number,
  now: number,
  nextRandom: () => number,
  delays: ReadonlyArray<number> = DEFAULT_THROTTLE_RETRY_DELAYS_MS,
  retryAfterJitterMs: number = DEFAULT_RETRY_AFTER_JITTER_MS
): number | undefined => {
  if (attempt >= delays.length) return undefined
  const ceiling = delays[delays.length - 1]!
  const stated = retryAfterMsOf(e, now)
  if (stated !== undefined) return stated > ceiling ? undefined : stated + nextRandom() * retryAfterJitterMs
  return jittered(delays[attempt]!, nextRandom)
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A response cut at the output ceiling is a failed attempt, never an answer: cut prose would
// terminate the turn half-written, and a cut tool call's arguments stopped mid-JSON, so
// decoding the fragment executes half a program. The industry answer is retry with a higher
// ceiling (Anthropic documents exactly this for incomplete tool_use; the AI SDK removed its
// continuation feature in v5), so the attempt re-runs up the ladder, in-act like the throttle
// retries, and the top rung failing truncates LOUDLY as the turn's terminal
// (model.test.ts, "truncation").
export const MAX_TOKENS_LADDER = [32_768, 65_536]

// ladderOf bounds the retry ladder by the declared ceiling: never a rung above what the model
// can produce, and the declared cap is always the last rung, so the loud failure names the
// model's true limit (model.test.ts, "declared limits"). `rungs` is the ladder to bound,
// MAX_TOKENS_LADDER when the caller states none.
export const ladderOf = (declared?: number, rungs: ReadonlyArray<number> = MAX_TOKENS_LADDER): ReadonlyArray<number> => {
  if (declared === undefined) return rungs
  return [...rungs.filter((r) => r < declared), declared]
}

class TruncatedError extends Error {
  readonly truncated = true
  readonly usage: Usage | undefined
  constructor(ceiling: number, usage: Usage | undefined) {
    super(`the model's answer was cut at the ${ceiling}-token output ceiling`)
    this.usage = usage
  }
}

const isTruncated = (e: unknown): e is TruncatedError =>
  typeof e === "object" && e !== null && (e as { truncated?: unknown }).truncated === true

// The Converse leg, v5's shape cut to its core: the SDK authenticates to the GATEWAY (its own
// authorization header is stripped; `cf-aig-authorization` carries our token, the gateway holds
// the AWS credential), and the dynamic SDK import is resolved statically because wrangler's
// esbuild cannot follow the adapter's indirection on workerd.
type SmithyHandler = Pick<FetchHttpHandler, "handle" | "destroy">

// bedrockHandler selects a transport that can enforce the configured stream bounds. Bun's
// fetch transport cannot carry a numeric deadline through Smithy's Request object, while
// workerd cannot use the Node transport.
const bedrockHandler = (config: ModelConfig, bounds: StreamBounds): SmithyHandler => {
  const transport: Promise<SmithyHandler> =
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? Promise.resolve(new FetchHttpHandler({ requestTimeout: bounds.totalMs }))
      : (() => {
          const moduleName = "@smithy/node-http-handler"
          return (import(/* @vite-ignore */ moduleName) as Promise<typeof import("@smithy/node-http-handler")>).then(
            ({ NodeHttpHandler: Handler }) =>
              new Handler({
                connectionTimeout: bounds.firstChunkMs,
                socketTimeout: bounds.idleMs,
                requestTimeout: bounds.totalMs,
                throwOnRequestTimeout: true
              })
          )
        })()

  return {
    handle: async (request, handlerOptions) => {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== "authorization")
      )
      request.headers["cf-aig-authorization"] = `Bearer ${config.apiKey}`
      return (await transport).handle(request, handlerOptions)
    },
    destroy: () => {
      void transport.then((handler) => handler.destroy()).catch(() => undefined)
    }
  }
}

// bedrockAdapter subclasses the Converse adapter for the two things the wire needs and the
// adapter does not do on its own: the gateway's own authorization, and the output ceiling.
//
// `output` is the third. The adapter's own structured-output path forces a tool and reads its
// arguments back, which is the protocol this framework removed; Converse has a native surface
// (`outputConfig.textFormat`, @aws-sdk/client-bedrock-runtime), so the schema goes there and the
// response arrives as ordinary text content the stream processor already accumulates.
export const bedrockAdapter = (
  config: ModelConfig,
  maxTokens: number,
  bounds: StreamBounds,
  output?: OutputRequest,
  mode: OutputMode = NATIVE_MODE,
  stops: { stopReason?: string } = {},
  reported: { usage?: unknown } = {}
) => {
  const handler = bedrockHandler(config, bounds)
  const region = config.baseUrl.split("/").filter((s) => s !== "").at(-1) ?? "us-east-1"
  return new (class extends BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]> {
    protected override importBedrockRuntime(): Promise<typeof BedrockRuntime> {
      return Promise.resolve(BedrockRuntime)
    }
    protected override buildClientConfig(
      resolved: Parameters<BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]>["buildClientConfig"]>[0],
      resolvedRegion: string,
      endpoint: string | undefined
    ) {
      // maxAttempts: 1 turns off the AWS SDK's own retry (it counts the first try as attempt
      // one), so a throttle-shaped failure surfaces to `infer`'s own retry loop instead of
      // being retried twice, once inside the SDK on its own schedule and once outside on ours.
      return { ...super.buildClientConfig(resolved, resolvedRegion, endpoint), requestHandler: handler, maxAttempts: 1 }
    }
    public override buildInput(options: Parameters<BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]>["buildInput"]>[0]) {
      const input = super.buildInput(options) as BedrockRuntime.ConverseStreamCommandInput
      // Converse truncates at its own small default otherwise, and a truncated stream ends a
      // tool call with EMPTY arguments: a whole generated code body silently gone.
      input.inferenceConfig = { ...input.inferenceConfig, maxTokens }
      const outputConfig = output === undefined ? undefined : converseOutputConfig(output, mode)
      if (outputConfig !== undefined) input.outputConfig = { ...input.outputConfig, ...outputConfig }
      return input
    }
    protected override async sendStream(input: BedrockRuntime.ConverseStreamCommandInput) {
      const stream = await super.sendStream(input)
      return tapStopReason(tapConverseUsage(stream, reported), stops)
    }
  })({ apiKey: "byok", region, baseURL: config.baseUrl }, config.model as (typeof BEDROCK_CONVERSE_MODELS)[number])
}

// FetchImpl is the callable half of fetch, spelled via Parameters so the same file
// typechecks under workers, bun, and dom globals (their fetch types differ in extras like
// preconnect, never in the call shape).
type FetchImpl = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>

// The attempt's idempotency key rides as the standard header on the OpenAI-compat wire, so a
// provider (or gateway) that dedups collapses a crashed attempt's retry into the first call.
// The Converse wire has no idempotency surface, so the bedrock leg ignores the key and the
// retry stays plain at-least-once there.
const withKey = (base: FetchImpl | undefined, key: string | undefined): FetchImpl | undefined => {
  if (key === undefined) return base
  const inner = base ?? globalThis.fetch
  return (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set("Idempotency-Key", key)
    return inner(input, { ...init, headers })
  }
}

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

type BodyReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel: () => Promise<unknown>
}

// Wire is what the raw body said about the attempt beyond the adapter's view: the last `usage`
// object, and the serving provider and resolved model when the gateway names them (OpenRouter
// stamps `provider` on each chunk; `model` is standard). Wire-reported provenance beats the
// configured stamp: it is observed, never declared.
interface Wire {
  readonly usage?: unknown
  readonly usageReports?: ReadonlyArray<unknown>
  readonly provider?: string
  readonly model?: string
  // A structured-output refusal arrives as `choices[].delta.refusal` with an ordinary `stop`
  // finish reason, and the adapter's processor keeps neither. The raw body is the only place it
  // survives, so it is read here (model.test.ts, "a refusal on the wire").
  readonly refusal?: string
}

// captureWire reads the last `usage` object (and provenance) off an SSE (or JSON) body. The
// OpenAI-compat adapter normalizes tokens and drops extra keys; a gateway's billed dollar
// lives on those keys (packages/agent/src/usage.ts, costNumber).
const captureWire = async (reader: BodyReader): Promise<Wire | undefined> => {
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(value)
    }
  } catch {
    // the live branch already failed; bytes read so far may still hold a usage chunk
  }
  const text = new TextDecoder().decode(concatBytes(chunks))
  const refusalOf = (parsed: { choices?: ReadonlyArray<{ delta?: { refusal?: unknown }; message?: { refusal?: unknown } }> }): string | undefined => {
    for (const choice of parsed.choices ?? []) {
      const refusal = choice.delta?.refusal ?? choice.message?.refusal
      if (typeof refusal === "string" && refusal !== "") return refusal
    }
    return undefined
  }
  const wireOf = (parsed: { usage?: unknown; provider?: unknown; model?: unknown }): Wire => {
    const refusal = refusalOf(parsed as never)
    return {
      ...(parsed.usage === undefined || parsed.usage === null ? {} : { usage: parsed.usage }),
      ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(refusal === undefined ? {} : { refusal })
    }
  }
  let last: Wire = {}
  for (const line of text.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : ""
    if (payload === "" || payload === "[DONE]") continue
    try {
      const next = wireOf(JSON.parse(payload) as never)
      const usageReports =
        next.usage === undefined ? last.usageReports : [...(last.usageReports ?? []), next.usage]
      // Refusal deltas arrive in pieces, like content: each chunk carries the next fragment.
      last = {
        ...last,
        ...next,
        ...(usageReports === undefined ? {} : { usageReports }),
        ...(next.refusal === undefined ? {} : { refusal: `${last.refusal ?? ""}${next.refusal}` })
      }
    } catch {
      // a keep-alive or a malformed line is not usage
    }
  }
  if (Object.keys(last).length > 0) return last
  try {
    const wire = wireOf(JSON.parse(text) as never)
    if (Object.keys(wire).length === 0) return undefined
    return wire.usage === undefined ? wire : { ...wire, usageReports: [wire.usage] }
  } catch {
    return undefined
  }
}

const withCapture = (
  base: FetchImpl | undefined,
  key: string | undefined,
  timeoutMs: number,
  sink: { promise: Promise<Wire | undefined>; reader?: BodyReader }
): FetchImpl => {
  const inner = withKey(base, key) ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    const timed = { ...init, timeout: timeoutMs } as NonNullable<Parameters<FetchImpl>[1]>
    const res = await inner(input, timed)
    if (res.body === null) return res
    const [live, copy] = res.body.tee()
    const reader = copy.getReader()
    sink.reader = reader
    sink.promise = captureWire(reader).catch(() => undefined)
    return new Response(live, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

const tapTokens = (
  stream: AsyncIterable<StreamChunk>,
  into: { tokens?: TokenUsage }
): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    for await (const chunk of stream) {
      const tokens = (chunk as { usage?: TokenUsage }).usage
      if (tokens !== undefined) into.tokens = tokens
      yield chunk
    }
  }
})

const withSpend = (action: Action, usage: Usage | undefined): Action =>
  usage === undefined ? action : { ...action, usage }

const stampOf = (config: ModelConfig) => ({
  ...(config.provider === undefined ? {} : { provider: config.provider }),
  model: config.model
})

// endpointOf is who served an attempt, recorded whether or not the endpoint reported a single
// token. The configured pair is always present, so a replay can say which model supplied a
// native guarantee even for an endpoint that bills nothing; a router that names the upstream it
// served from adds the observed pair beside it (tardie, src/events.ts, Endpoint).
const endpointOf = (config: ModelConfig, wire: Wire | undefined): AttemptEndpoint => ({
  ...stampOf(config),
  ...(wire?.provider === undefined ? {} : { routedProvider: wire.provider }),
  ...(wire?.model === undefined ? {} : { routedModel: wire.model })
})

const served = (action: Action, endpoint: AttemptEndpoint): Action => ({ ...action, endpoint })

// tapStopReason keeps the raw Converse stop reason the adapter's processor folds away, so a
// guardrail refusal and a malformed structured response are told apart from an ordinary stop
// (output.ts, converseStopClass).
export const tapStopReason = <T>(
  stream: AsyncIterable<T>,
  into: { stopReason?: string }
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for await (const event of stream) {
      const stop = (event as { messageStop?: { stopReason?: unknown } }).messageStop?.stopReason
      if (typeof stop === "string") into.stopReason = stop
      yield event
    }
  }
})

// tapConverseUsage preserves the SDK's provider metrics before the shared adapter drops cache
// details (model.test.ts, "the Converse usage tap keeps the raw provider metrics").
export const tapConverseUsage = <T>(
  stream: AsyncIterable<T>,
  into: { usage?: unknown }
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for await (const event of stream) {
      const usage = (event as { metadata?: { usage?: unknown } }).metadata?.usage
      if (usage !== undefined) into.usage = usage
      yield event
    }
  }
})

const usageOn = (e: unknown): Usage | undefined =>
  e !== null && typeof e === "object" && "usage" in e ? (e as { usage?: Usage }).usage : undefined

const endpointOn = (e: unknown): AttemptEndpoint | undefined =>
  e !== null && typeof e === "object" && "endpoint" in e ? (e as { endpoint?: AttemptEndpoint }).endpoint : undefined

const carriesEndpoint = (e: unknown): boolean => endpointOn(e) !== undefined

// failed attaches an attempt's spend and endpoint to a failure the loop above classifies, so the
// two survive the throw the way a truncation's own do.
const failed = <E extends Error>(error: E, usage: Usage | undefined, endpoint: AttemptEndpoint): E =>
  Object.assign(error, { usage, endpoint })

const spentOf = (parts: ReadonlyArray<Usage>, missed: boolean): Usage | undefined => {
  if (parts.length === 0) return undefined
  const summed = sumUsage(parts)
  if (!missed) return summed
  return {
    promptTokens: summed.promptTokens,
    completionTokens: summed.completionTokens,
    ...(summed.totalTokens === undefined ? {} : { totalTokens: summed.totalTokens }),
    ...(summed.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: summed.cachedPromptTokens }),
    ...(summed.cacheWritePromptTokens === undefined
      ? {}
      : { cacheWritePromptTokens: summed.cacheWritePromptTokens }),
    ...(summed.reasoningTokens === undefined ? {} : { reasoningTokens: summed.reasoningTokens }),
    ...(summed.provider === undefined ? {} : { provider: summed.provider }),
    ...(summed.model === undefined ? {} : { model: summed.model }),
    ...(summed.providerReports === undefined ? {} : { providerReports: summed.providerReports })
  }
}

// infer provides NativeOutputSupport in its layer type only for a statically known native capability that accepts tools.
export const infer = <const C extends ModelConfig>(config: C): Layer.Layer<Infer | NativeOutputProvided<C>> => {
  assertSupportedBun()
  if (!Number.isSafeInteger(config.contextWindowTokens) || config.contextWindowTokens <= 0) {
    throw new Error(`contextWindowTokens must be a positive integer, got ${config.contextWindowTokens}`)
  }
  const sleep = config.sleep ?? realSleep
  const bounds: StreamBounds = {
    firstChunkMs: config.stream?.firstChunkMs ?? DEFAULT_STREAM_BOUNDS.firstChunkMs,
    idleMs: config.stream?.idleMs ?? DEFAULT_STREAM_BOUNDS.idleMs,
    totalMs: config.stream?.totalMs ?? DEFAULT_STREAM_BOUNDS.totalMs
  }
  // bounds rejects values Bun would clamp to 1ms, which would report healthy providers as timed
  // out (model.test.ts, "stream bounds").
  for (const [name, ms] of Object.entries(bounds)) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) {
      throw new Error(`stream ${name} must be a finite positive count of milliseconds no greater than ${MAX_TIMER_DELAY_MS}; got ${ms}`)
    }
  }
  const throttleDelays = config.throttleRetryDelaysMs ?? DEFAULT_THROTTLE_RETRY_DELAYS_MS
  const retryAfterJitterMs = config.retryAfterJitterMs ?? DEFAULT_RETRY_AFTER_JITTER_MS
  const failurePolicy = { throttleRetryDelaysMs: throttleDelays, retryAfterJitterMs, stream: bounds }
  const attemptOnce = async (
    req: ModelRequest,
    mode: OutputMode,
    key: string | undefined,
    maxTokens: number,
    rung: number,
    stats: { finish?: string }
  ): Promise<Action> => {
    // Every consequence of a declared-output attempt names the mode it ran in, so replay reads a
    // recorded fact rather than re-deciding from a capability that may have changed since
    // (tardie, runtime/infer.ts, completionOf).
    const stamped = (action: Action): Action => (req.output === undefined ? action : { ...action, mode })
    // A changed ceiling is a different request, so it mints a different idempotency key: a
    // provider that dedups would otherwise answer the escalated retry with the cached truncated
    // response, and the ladder would climb nowhere (the removed driver learned this). Rung zero
    // keeps the bare key, so crash-retries of the same request still collapse.
    const keyForRung = key === undefined ? undefined : rung === 0 ? key : `${key}/mt${maxTokens}`
    const sink: { promise: Promise<Wire | undefined>; reader?: BodyReader } = {
      promise: Promise.resolve(undefined)
    }
    const reported: { usage?: unknown } = {}
    const held: { tokens?: TokenUsage } = {}
    const fetcher = withCapture(config.fetch, keyForRung, bounds.totalMs, sink)
    const stops: { stopReason?: string } = {}
    const adapter = config.driver === "bedrock-converse"
      ? bedrockAdapter(config, maxTokens, bounds, req.output, mode, stops, reported)
      : config.driver === "anthropic-messages"
        ? createAnthropicChat(config.model as never, config.apiKey, {
            baseURL: config.baseUrl,
            maxRetries: 0,
            fetch: fetcher
          })
        : openaiCompatibleText(config.model, {
            name: "tardigrade",
            baseURL: config.baseUrl,
            apiKey: config.apiKey,
            api: config.driver === "openai-responses" ? "responses" : "chat-completions",
            // The OpenAI client retries a throttle-shaped failure on its own schedule by
            // default (`maxRetries: 2`, real waits it does not expose to us). Turned off here so
            // a 429 or a 5xx surfaces to `react`'s own retry loop once, on our own backoff.
            maxRetries: 0,
            fetch: fetcher
          })
    // The declared contract rides each wire's own surface: `response_format` through the
    // compatible leg's provider-options seam, and `outputConfig` through the Converse leg's
    // buildInput above. Both are absent under an implementation that asked for no guarantee, so
    // no endpoint is handed a schema it never promised to keep.
    const responseFormat = config.driver === "openai-responses" || config.driver === "openai-chat-completions"
      ? compatibleResponseFormat(req.output, mode)
      : undefined
    const outputSchema = config.driver === "anthropic-messages" && req.output?.kind === "contract" && mode.kind === "native"
      ? req.output.contract.schema
      : undefined
    // The fallback's own instruction rides the request and reaches the model only on an attempt
    // running as that fallback, so a native attempt sends exactly the base prompt.
    const fallbackSystem = fallbackSystemFor(req.output, mode)
    const stream = adapter.chatStream({
      model: config.model,
      messages: req.messages.map(toMessage) as never,
      tools: req.tools.map(toTool) as never,
      systemPrompts: fallbackSystem === undefined ? [req.system] : [req.system, fallbackSystem],
      modelOptions: {
        // The ceiling rides the wire explicitly on the compatible leg (provider-native sampling
        // key), the same number the Bedrock leg pins through inferenceConfig: an unstated ceiling
        // is a provider default nobody chose.
        max_tokens: maxTokens,
        ...(responseFormat === undefined ? {} : { response_format: responseFormat })
      } as never,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      logger: noopLogger
    } as never)
    // The wire is read once and answers two questions: what the attempt spent, and who served
    // it. The endpoint stands whether or not any spend was reported, so an endpoint that bills
    // nothing is still named in the log (tardie, src/events.ts, Endpoint).
    const settle = async (): Promise<{ readonly usage: Usage | undefined; readonly endpoint: AttemptEndpoint; readonly wire: Wire | undefined }> => {
      const wire = await sink.promise
      // Wire-reported provenance wins: a router that names the upstream it served from records
      // the true split; the configured stamp covers a wire that stays silent.
      const providerMetrics = wire?.usageReports ?? (reported.usage === undefined ? [] : [reported.usage])
      const usage = usageFrom(
        [...providerMetrics, held.tokens],
        config.pricing,
        {
          ...stampOf(config),
          ...(wire?.provider === undefined ? {} : { provider: wire.provider }),
          ...(wire?.model === undefined ? {} : { model: wire.model })
        },
        providerMetrics.length === 0
          ? undefined
          : providerMetrics.length === 1
            ? providerMetrics[0]
            : providerMetrics
      )
      return { usage, endpoint: endpointOf(config, wire), wire }
    }
    try {
      const result = await new StreamProcessor().process(tapTokens(bounded(stream, bounds), held))
      const { usage, endpoint, wire } = await settle()
      stats.finish = stops.stopReason ?? result.finishReason ?? "stop"
      const converse = converseStopClass(stops.stopReason)
      if (result.finishReason === "length" || converse === "truncated") throw new TruncatedError(maxTokens, usage)
      // A structured-output refusal reaches the compatible wire as a `refusal` delta under an
      // ordinary stop, and the Converse wire as its own stop reason. Neither survives the shared
      // processor, so both are read here rather than from the decoded result.
      if (wire?.refusal !== undefined) throw failed(new RefusedError(`the provider refused to answer this request: ${wire.refusal}`), usage, endpoint)
      if (converse === "refused") throw failed(new RefusedError("the provider refused to answer this request"), usage, endpoint)
      if (converse === "violation") {
        throw failed(new ViolatedError("the provider could not produce output matching the schema it was given"), usage, endpoint)
      }
      return stamped(served(withSpend(actionOf(result), usage), endpoint))
    } catch (e) {
      await sink.reader?.cancel().catch(() => undefined)
      // A truncation already carries its own spend; every other failure gets the attempt's spend
      // and endpoint attached here so both survive the throw.
      if (isTruncated(e) || carriesEndpoint(e)) throw e
      const { usage, endpoint } = await settle()
      if (e !== null && typeof e === "object") throw Object.assign(e, { usage, endpoint })
      throw Object.assign(new Error(String(e)), { usage, endpoint })
    }
  }
  const layer = Layer.succeed(Infer, {
    resolve: (coordinate) => {
      if (coordinate.provider !== config.provider || coordinate.model_id !== config.model) {
        throw new Error(
          `model ${coordinate.provider}/${coordinate.model_id} is not bound; this host binds ${config.provider}/${config.model}`
        )
      }
      return {
        model: coordinate,
        contextWindowTokens: config.contextWindowTokens,
        ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens })
      }
    },
    react: Effect.fn("llm.react", {
      kind: "client",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": config.model,
        "gen_ai.provider.name": config.driver === "bedrock-converse" ? "aws.bedrock" : (config.provider ?? config.driver)
      }
    })(function* (request: InferRequest, key?: string) {
      // The retry ladder reads the wall clock to honour a provider's `Retry-After` date, and it
      // reads it from the Clock the caller supplied rather than the global one, so a test drives
      // the ladder without waiting on real time (model.test.ts, "infer: throttle-shaped retry").
      const clock = yield* Clock.Clock
      const random = yield* Random.Random
      const ladder = ladderOf(config.maxOutputTokens, config.maxTokensLadder)
      const stats: { finish?: string; rung: number; waits: number; attempts: number } = {
        rung: 0,
        waits: 0,
        attempts: 0
      }
      // The actor decides the request, render included; the platform maps it to the wire and
      // streams it, holding no opinion about tools (tardie, runtime/agent.ts).
      const req = modelRequest(request.trajectory, request, request.context ?? {})
      // The contract's preflight runs before the first socket: an endpoint that cannot promise
      // the declared schema, or a schema outside the profile both wires send unchanged, ends
      // the turn having spent nothing (src/output.ts, outputPreflight).
      const selected = outputModeOf(req, config)
      if ("errors" in selected) {
        const action: Action = {
          kind: "fail",
          error: selected.errors.join("\n"),
          endpoint: endpointOf(config, undefined),
          failure: {
            cause: "output_unsupported",
            attempts: 0,
            policy: { provider: config.provider, model: config.model, output: capabilityOf(config) }
          }
        }
        yield* Effect.annotateCurrentSpan("gen_ai.output.supported", false)
        return action
      }
      const mode = selected.mode
      if (req.output?.kind === "contract") {
        yield* Effect.annotateCurrentSpan("gen_ai.output.contract", req.output.contract.name)
        yield* Effect.annotateCurrentSpan("gen_ai.output.mode", mode.name)
        yield* Effect.annotateCurrentSpan("gen_ai.output.native", mode.kind === "native")
      }
      const action = yield* Effect.promise<Action>(async () => {
        let rung = 0
        const parts: Usage[] = []
        let missed = false
        const remember = (usage: Usage | undefined, billed: boolean) => {
          if (usage !== undefined) parts.push(usage)
          else if (billed) missed = true
        }
        for (let attempt = 0; ; attempt++) {
          try {
            stats.rung = rung
            stats.attempts += 1
            const action = await attemptOnce(req, mode, key, ladder[rung]!, rung, stats)
            remember(action.usage, true)
            return served(withSpend(action, spentOf(parts, missed)), action.endpoint ?? endpointOf(config, undefined))
          } catch (e) {
            const usage = isTruncated(e) ? e.usage : usageOn(e)
            const endpoint = endpointOn(e) ?? endpointOf(config, undefined)
            const ends = (action: Action): Action => {
              const billed = served(withSpend(action, spentOf(parts, missed)), endpoint)
              return req.output === undefined ? billed : { ...billed, mode }
            }
            remember(usage, isTruncated(e) || usage !== undefined)
            if (isTruncated(e)) {
              if (rung + 1 < ladder.length) {
                rung += 1
                continue
              }
              // The top rung still truncates: the turn fails loudly instead of shipping half an
              // answer, and the error names the remedy.
              return ends({
                kind: "fail",
                error: `${e.message}; the answer does not fit the largest ceiling, so the task must produce less at once`,
                failure: { cause: "truncated", attempts: stats.attempts, policy: { maxTokensLadder: ladder } }
              })
            }
            // A refusal is the provider declining this request. The same request retried earns
            // the same refusal, so the ladder stops here and the turn records why.
            if (isRefused(e)) {
              return ends({
                kind: "fail",
                error: e instanceof Error ? e.message : String(e),
                failure: { cause: "refused", attempts: stats.attempts }
              })
            }
            // The endpoint said outright that it could not produce the output it was constrained
            // to. Retrying asks the same endpoint for the same broken promise.
            if (isViolation(e)) {
              return ends({
                kind: "fail",
                error: e instanceof Error ? e.message : String(e),
                failure: { cause: "output_contract_violation", attempts: stats.attempts }
              })
            }
            if (!isThrottleShaped(e)) {
              const message = e instanceof Error ? e.message : String(e)
              return ends({
                kind: "fail",
                error: `model inference failed after ${stats.attempts} attempt${stats.attempts === 1 ? "" : "s"}: ${message}`,
                failure: { cause: "inference_error", attempts: stats.attempts, policy: failurePolicy }
              })
            }
            const delay = throttleDelayMs(
              e,
              attempt,
              clock.currentTimeMillisUnsafe(),
              () => random.nextDoubleUnsafe(),
              throttleDelays,
              retryAfterJitterMs
            )
            if (delay === undefined) {
              const message = e instanceof Error ? e.message : String(e)
              return ends({
                kind: "fail",
                error: `model inference retries exhausted after ${stats.attempts} attempt${stats.attempts === 1 ? "" : "s"}: ${message}`,
                failure: {
                  cause: "inference_attempts_exhausted",
                  attempts: stats.attempts,
                  policy: failurePolicy
                }
              })
            }
            stats.waits += 1
            await sleep(delay)
          }
        }
      })
      // The wide-span discipline: everything a failure query filters by rides the one span.
      // Names follow the GenAI semantic conventions where they exist (registry, 2026).
      yield* Effect.annotateCurrentSpan("gen_ai.response.finish_reasons", [stats.finish ?? "unknown"])
      yield* Effect.annotateCurrentSpan("retry.rung", stats.rung)
      yield* Effect.annotateCurrentSpan("retry.throttle_waits", stats.waits)
      yield* Effect.annotateCurrentSpan("retry.attempts", stats.attempts)
      if (action.usage !== undefined) {
        // The usage stamp may carry wire-reported provenance; the span follows the same rule.
        if (action.usage.provider !== undefined) {
          yield* Effect.annotateCurrentSpan("gen_ai.provider.name", action.usage.provider)
        }
        yield* Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", action.usage.promptTokens)
        yield* Effect.annotateCurrentSpan("gen_ai.usage.output_tokens", action.usage.completionTokens)
        if (action.usage.cachedPromptTokens !== undefined) {
          yield* Effect.annotateCurrentSpan("gen_ai.usage.cache_read.input_tokens", action.usage.cachedPromptTokens)
        }
        if (action.usage.cacheWritePromptTokens !== undefined) {
          yield* Effect.annotateCurrentSpan("gen_ai.usage.cache_creation.input_tokens", action.usage.cacheWritePromptTokens)
        }
        if (action.usage.reasoningTokens !== undefined) {
          yield* Effect.annotateCurrentSpan("gen_ai.usage.reasoning.output_tokens", action.usage.reasoningTokens)
        }
        if (action.usage.costUsd !== undefined) {
          yield* Effect.annotateCurrentSpan("gen_ai.usage.cost", action.usage.costUsd)
          if (action.usage.costSource !== undefined) {
            yield* Effect.annotateCurrentSpan("gen_ai.usage.cost_source", action.usage.costSource)
          }
        }
        if (action.usage.reportedCostUsd !== undefined) {
          yield* Effect.annotateCurrentSpan("tardigrade.usage.reported_cost", action.usage.reportedCostUsd)
        }
        if (action.usage.estimatedCostUsd !== undefined) {
          yield* Effect.annotateCurrentSpan("tardigrade.usage.estimated_cost", action.usage.estimatedCostUsd)
        }
      }
      return action
    })
  })
  return (
    config.output?.guarantee === "native" && config.output.withTools
      ? Layer.mergeAll(layer, Layer.succeed(NativeOutputSupport, { withTools: true }))
      : layer
  ) as Layer.Layer<Infer | NativeOutputProvided<C>>
}
