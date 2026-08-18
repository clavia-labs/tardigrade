import { Effect, Layer } from "effect"
import { StreamProcessor, type ModelMessage, type ProcessorResult, type StreamChunk, type Tool, type ToolCall } from "@tanstack/ai"
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime"
import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import { BedrockConverseTextAdapter, type BEDROCK_CONVERSE_MODELS } from "@tanstack/ai-bedrock"
import { Infer, type InferRequest } from "@tardigrade/agent/infer"
import type { Action } from "@tardigrade/agent/events"
import type { Event } from "@tardigrade/core/event"
import { answerErrors, outputSchemaOf } from "@tardigrade/agent/contract"
import { modelRequest, type AgentMessage, type ToolSpec } from "@tardigrade/agent/request"
import { sumUsage, usageFrom, type ModelPricing, type Usage } from "@tardigrade/agent/usage"

// The real model binding: one inference per react, streamed through a TanStack adapter and
// decoded by their StreamProcessor. The reactors never learn this layer exists. Resilience is
// layered: the stream bounds below catch a hung provider inside the call, the platform's 30s
// liveness alarm catches a hung binding, and the marks-and-give-up fold bounds the retries. A
// thrown attempt here is an attempt that died, and the next settle retries it.

export interface ModelEnv {
  readonly MODEL_BASE_URL?: string // OpenAI-compat endpoint, or the gateway's bedrock-runtime URL
  readonly MODEL_API_KEY?: string
  readonly MODEL_ID?: string
  readonly MODEL_SONNET_ID?: string
  readonly MODEL_OPUS_ID?: string
  readonly MODEL_HAIKU_ID?: string
  // "bedrock" speaks Converse through the gateway's aws-bedrock route (v5's proven leg);
  // anything else is the OpenAI-compat wire.
  readonly MODEL_PROVIDER?: string
}

export const modelConfigured = (env: ModelEnv): boolean =>
  env.MODEL_BASE_URL !== undefined && env.MODEL_API_KEY !== undefined && env.MODEL_ID !== undefined

// The model vocabulary agents speak: short names, resolved to provider ids by env. An unknown
// or absent name is the default. The asked name rides the brief's MessageReceived envelope, so
// the choice is in the log and replay agrees by construction; latest brief wins.
export const modelIdOf = (env: ModelEnv, name?: string): string =>
  name === "opus"
    ? (env.MODEL_OPUS_ID ?? env.MODEL_ID!)
    : name === "sonnet"
      ? (env.MODEL_SONNET_ID ?? env.MODEL_ID!)
      : name === "haiku"
        ? (env.MODEL_HAIKU_ID ?? env.MODEL_ID!)
        : env.MODEL_ID!

export const modelAskOf = (trajectory: ReadonlyArray<Event>): string | undefined => {
  let name: string | undefined
  for (const e of trajectory) {
    if (e.type !== "MessageReceived") continue
    const v = (e as { model?: unknown }).model
    if (typeof v === "string" && v !== "") name = v
  }
  return name
}

// StreamBounds is time to first chunk, idle between chunks, and the whole stream. Each timeout
// throws; the attempt dies and the marks count it (v5's stream-idle lesson).
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

// The decode: the processed stream becomes one Action. A tool call acts; plain text completes;
// nothing at all is a failed attempt (thrown, so the marks count it and the settle retries).
export const actionOf = (result: ProcessorResult, schema?: unknown): Action => {
  const calls = result.toolCalls ?? []
  const text = (result.content ?? "").trim()
  // An answer call ends the turn with its arguments as the structured output, but only when
  // those arguments satisfy the schema this turn declared. A tool call is well-formed long
  // before it is correct: a model can put a stringified array where an array belongs. An answer
  // that misses goes back as a call, and the tools reactor returns the reasons.
  const answered = calls.find((c) => c.function.name === "answer")
  if (answered !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(answered.function.arguments)
    } catch {
      parsed = undefined
    }
    const errors = answerErrors(schema, parsed)
    if (errors.length === 0) return { kind: "complete", output: answered.function.arguments }
    return { kind: "call", callId: answered.id, name: "answer", arguments: parsed, ...(text === "" ? {} : { text }) }
  }
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
  // Prose terminates a turn that declared nothing. Under a schema it cannot: the answer has a
  // declared shape, and text is not it, so the turn goes back for a real answer.
  if (text !== "") {
    if (schema === undefined) return { kind: "complete", output: text }
    return { kind: "call", callId: `${result.toolCalls?.[0]?.id ?? "answer"}/prose`, name: "answer", arguments: undefined, text }
  }
  throw new Error("the model produced neither text nor a tool call")
}

const noopLogger = new Proxy({}, { get: () => () => {} }) as never

export interface ModelConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly provider?: string
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
  // What the model costs, when a catalog or a caller has said. A billed figure from the
  // provider is preferred; this table fills only a cost the provider omitted
  // (packages/agent/src/usage.ts, priced). Cached prompt tokens price at the full input rate.
  readonly pricing?: ModelPricing
  // In-act backoff bases for throttle-shaped failures. Length is the retry count.
  readonly throttleRetryDelaysMs?: ReadonlyArray<number>
  readonly fetch?: FetchImpl // test seam
  readonly sleep?: (ms: number) => Promise<void> // test seam: swap the backoff wait for an instant one
}

// Throttle-shaped failures die fast under fan-out: many agents firing at once trip the gateway's
// rate limit, and three back-to-back attempts with no wait between them exhaust
// infer's give-up ceiling (`inferReactorFor`) before the throttle even clears. `inferMachine`'s
// attempt/give-up fold has no notion of time: settleActor (src/core/actor.ts) re-serves owed
// work on the very next event, and a delayed re-serve would need the lane to rest until an
// alarm keyed off the attempt count wakes it — a real change to the reactor
// framework's vocabulary, not a local one. The seam that IS local and honest: retry the
// throttle-shaped failure inside this one act, before it ever becomes a died mark, so the
// attempt counter only counts failures that were not a gateway saying "slow down". Retries stay
// bounded (the configured delay list's length) so a genuinely wedged provider still
// dies and gives up in time.
//
// The openai SDK client `chatStream` runs on (`@tanstack/openai-base`) throws its `APIError`
// subclasses with a numeric `.status`: 429 is the gateway's rate limit, 5xx is its own upstream
// trouble. `bounded()` below throws plain `Error`s for the same shape of failure (a stream that
// never starts or stalls), so the message is checked too.
export const DEFAULT_THROTTLE_RETRY_DELAYS_MS: ReadonlyArray<number> = [2_000, 8_000, 30_000]

const isThrottleShaped = (e: unknown): boolean => {
  const err = e as { status?: unknown; statusCode?: unknown; message?: unknown }
  const status = typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined
  if (status === 429 || (status !== undefined && status >= 500)) return true
  const message = String(err.message ?? e)
  return /\b429\b|rate.?limit|too many requests|\b5\d\d\b|timeout|idle beyond bound|exceeded its total bound|no first chunk within bound|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
    message
  )
}

// Full jitter (AWS's term for it): a uniform draw between 0 and the base, so many attempts
// throttled at the same instant do not retry in lockstep and re-trip the same limit together.
const jittered = (baseMs: number): number => Math.random() * baseMs

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
// the ladder's own ceiling (plus up to a second of jitter, so a herd released together does not
// re-trip the limit), the jittered ladder otherwise, and undefined for a stated wait past the
// ceiling: holding a turn open longer than the ladder ever would is worse than dying, and a
// died attempt's mark lets the platform alarm re-drive after the queue clears.
export const throttleDelayMs = (
  e: unknown,
  attempt: number,
  now: number,
  delays: ReadonlyArray<number> = DEFAULT_THROTTLE_RETRY_DELAYS_MS
): number | undefined => {
  if (attempt >= delays.length) return undefined
  const ceiling = delays[delays.length - 1]!
  const stated = retryAfterMsOf(e, now)
  if (stated !== undefined) return stated > ceiling ? undefined : stated + Math.random() * 1_000
  return jittered(delays[attempt]!)
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
const bedrockAdapter = (config: ModelConfig, maxTokens: number) => {
  const handler = new (class extends FetchHttpHandler {
    override async handle(request: Parameters<FetchHttpHandler["handle"]>[0], handlerOptions?: Parameters<FetchHttpHandler["handle"]>[1]) {
      request.headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.toLowerCase() !== "authorization"))
      request.headers["cf-aig-authorization"] = `Bearer ${config.apiKey}`
      return super.handle(request, handlerOptions)
    }
  })()
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
    protected override buildInput(options: Parameters<BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]>["buildInput"]>[0]) {
      const input = super.buildInput(options) as BedrockRuntime.ConverseStreamCommandInput
      // Converse truncates at its own small default otherwise, and a truncated stream ends an
      // `answer` tool call with EMPTY arguments: a whole generated code body silently gone.
      input.inferenceConfig = { ...input.inferenceConfig, maxTokens }
      return input
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
  readonly provider?: string
  readonly model?: string
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
  const wireOf = (parsed: { usage?: unknown; provider?: unknown; model?: unknown }): Wire => ({
    ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
    ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {})
  })
  let last: Wire = {}
  for (const line of text.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : ""
    if (payload === "" || payload === "[DONE]") continue
    try {
      last = { ...last, ...wireOf(JSON.parse(payload) as never) }
    } catch {
      // a keep-alive or a malformed line is not usage
    }
  }
  if (Object.keys(last).length > 0) return last
  try {
    const wire = wireOf(JSON.parse(text) as never)
    return Object.keys(wire).length > 0 ? wire : undefined
  } catch {
    return undefined
  }
}

const withCapture = (
  base: FetchImpl | undefined,
  key: string | undefined,
  sink: { promise: Promise<Wire | undefined>; reader?: BodyReader }
): FetchImpl => {
  const inner = withKey(base, key) ?? ((input, init) => globalThis.fetch(input, init))
  return async (input, init) => {
    const res = await inner(input, init)
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
  into: { tokens?: { readonly promptTokens: number; readonly completionTokens: number; readonly cost?: number } }
): AsyncIterable<StreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    for await (const chunk of stream) {
      const tokens = (chunk as { usage?: { promptTokens: number; completionTokens: number; cost?: number } }).usage
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

const usageOn = (e: unknown): Usage | undefined =>
  e !== null && typeof e === "object" && "usage" in e ? (e as { usage?: Usage }).usage : undefined

const spentOf = (parts: ReadonlyArray<Usage>, missed: boolean): Usage | undefined => {
  if (parts.length === 0) return undefined
  const summed = sumUsage(parts)
  if (!missed) return summed
  return {
    promptTokens: summed.promptTokens,
    completionTokens: summed.completionTokens,
    ...(summed.provider === undefined ? {} : { provider: summed.provider }),
    ...(summed.model === undefined ? {} : { model: summed.model })
  }
}

export const infer = (config: ModelConfig) => {
  const sleep = config.sleep ?? realSleep
  const bounds: StreamBounds = {
    firstChunkMs: config.stream?.firstChunkMs ?? DEFAULT_STREAM_BOUNDS.firstChunkMs,
    idleMs: config.stream?.idleMs ?? DEFAULT_STREAM_BOUNDS.idleMs,
    totalMs: config.stream?.totalMs ?? DEFAULT_STREAM_BOUNDS.totalMs
  }
  const throttleDelays = config.throttleRetryDelaysMs ?? DEFAULT_THROTTLE_RETRY_DELAYS_MS
  const attemptOnce = async (request: InferRequest, key: string | undefined, maxTokens: number, rung: number, stats: { finish?: string }): Promise<Action> => {
    // A changed ceiling is a different request, so it mints a different idempotency key: a
    // provider that dedups would otherwise answer the escalated retry with the cached truncated
     // response, and the ladder would climb nowhere (the removed driver learned this).
     // Rung zero keeps the bare key, so crash-retries of the same request still
    // collapse.
    const keyForRung = key === undefined ? undefined : rung === 0 ? key : `${key}/mt${maxTokens}`
    const sink: { promise: Promise<Wire | undefined>; reader?: BodyReader } = {
      promise: Promise.resolve(undefined)
    }
    const held: { tokens?: { readonly promptTokens: number; readonly completionTokens: number; readonly cost?: number } } = {}
    const fetcher = withCapture(config.fetch, keyForRung, sink)
    const adapter =
      config.provider === "bedrock"
        ? bedrockAdapter(config, maxTokens)
        : openaiCompatibleText(config.model, {
            name: "tardigrade",
            baseURL: config.baseUrl,
            apiKey: config.apiKey,
            // The openai SDK client retries a throttle-shaped failure on its own schedule by
            // default (`maxRetries: 2`, real waits it does not expose to us). Turned off here so
            // a 429 or a 5xx surfaces to `react`'s own retry loop once, on our own backoff.
            maxRetries: 0,
            fetch: fetcher
          })
    // The actor decides the request, render included; the platform maps it to the wire and
    // streams it, holding no opinion about tools (@tardigrade/agent, capability.ts).
    const req = modelRequest(request.trajectory, request, request.context ?? {})
    const schema = outputSchemaOf(request.trajectory) // the answer parser needs the turn's declared shape
    const stream = adapter.chatStream({
      model: config.model,
      messages: req.messages.map(toMessage) as never,
      tools: req.tools.map(toTool) as never,
      systemPrompts: [req.system],
      // The ceiling rides the wire explicitly on the compatible leg (provider-native sampling
      // key), the same number the Bedrock leg pins through inferenceConfig: an unstated ceiling
      // is a provider default nobody chose.
      modelOptions: { max_tokens: maxTokens } as never,
      logger: noopLogger
    } as never)
    const spendOf = async (): Promise<Usage | undefined> => {
      const wire = await sink.promise
      // Wire-reported provenance wins: a router that names the upstream it served from records
      // the true split; the configured stamp covers a wire that stays silent.
      return usageFrom([wire?.usage, held.tokens], config.pricing, {
        ...stampOf(config),
        ...(wire?.provider === undefined ? {} : { provider: wire.provider }),
        ...(wire?.model === undefined ? {} : { model: wire.model })
      })
    }
    try {
      const result = await new StreamProcessor().process(tapTokens(bounded(stream, bounds), held))
      const usage = await spendOf()
      stats.finish = result.finishReason ?? "stop"
      if (result.finishReason === "length") throw new TruncatedError(maxTokens, usage)
      return withSpend(actionOf(result, schema), usage)
    } catch (e) {
      await sink.reader?.cancel().catch(() => undefined)
      if (isTruncated(e)) throw e
      const usage = await spendOf()
      if (usage === undefined) throw e
      if (e !== null && typeof e === "object") throw Object.assign(e, { usage })
      throw Object.assign(new Error(String(e)), { usage })
    }
  }
  return Layer.succeed(Infer, {
    react: (request: InferRequest, key?: string) =>
      Effect.gen(function* () {
        const ladder = ladderOf(config.maxOutputTokens, config.maxTokensLadder)
        const stats: { finish?: string; rung: number; waits: number } = { rung: 0, waits: 0 }
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
            const action = await attemptOnce(request, key, ladder[rung]!, rung, stats)
            remember(action.usage, true)
            return withSpend(action, spentOf(parts, missed))
          } catch (e) {
            const usage = isTruncated(e) ? e.usage : usageOn(e)
            remember(usage, isTruncated(e) || usage !== undefined)
            if (isTruncated(e)) {
              if (rung + 1 < ladder.length) {
                rung += 1
                continue
              }
              // The top rung still truncates: the turn fails loudly instead of shipping half an
              // answer, and the error names the remedy.
              return withSpend(
                {
                  kind: "fail",
                  error: `${e.message}; the answer does not fit the largest ceiling, so the task must produce less at once`
                },
                spentOf(parts, missed)
              )
            }
            if (!isThrottleShaped(e)) throw e
            const delay = throttleDelayMs(e, attempt, Date.now(), throttleDelays)
            if (delay === undefined) throw e
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
        if (action.usage !== undefined) {
          // The usage stamp may carry wire-reported provenance; the span follows the same rule.
          if (action.usage.provider !== undefined) {
            yield* Effect.annotateCurrentSpan("gen_ai.provider.name", action.usage.provider)
          }
          yield* Effect.annotateCurrentSpan("gen_ai.usage.input_tokens", action.usage.promptTokens)
          yield* Effect.annotateCurrentSpan("gen_ai.usage.output_tokens", action.usage.completionTokens)
          if (action.usage.costUsd !== undefined) {
            yield* Effect.annotateCurrentSpan("gen_ai.usage.cost", action.usage.costUsd)
            if (action.usage.costSource !== undefined) {
              yield* Effect.annotateCurrentSpan("gen_ai.usage.cost_source", action.usage.costSource)
            }
          }
        }
        return action
      }).pipe(
        Effect.withSpan("llm.react", {
          kind: "client",
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": config.model,
            "gen_ai.provider.name": config.provider === "bedrock" ? "aws.bedrock" : (config.provider ?? "openai")
          }
        })
      )
  })
}
