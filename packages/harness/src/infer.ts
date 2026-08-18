import { Context, Effect, Layer } from "effect"
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider"
import type { ProviderOptions } from "@ai-sdk/provider-utils"
import type { Event } from "@flamecast/core"
import { estimateTextTokens } from "./context"
import type { Projection } from "./projection"

export interface NativeToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export interface NativeToolContext {
  readonly turn: string
  readonly callId: string
}

export interface NativeTool<R = never> {
  readonly spec: NativeToolSpec
  readonly run: (
    input: unknown,
    context?: NativeToolContext
  ) => Effect.Effect<unknown, never, R>
}

export interface NativeToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

// A provider can return opaque data that its next request must carry. Gemini thought signatures
// are one example. The protocol names the adapter that can read the value, so a later provider
// switch ignores data from an incompatible wire format.
export interface ProviderContinuation {
  readonly protocol: string
  readonly value: unknown
}

export interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string | null
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
  readonly toolCallId?: string
  // Which tool a result belongs to. The wire format pairs a result with its call by id and by name,
  // so the name travels with the result rather than being looked up from the call it answers.
  readonly toolName?: string
  readonly continuation?: ProviderContinuation
}

// How much a model thinks before it answers. The SDK translates one vocabulary into each provider's
// own, so this is the rare provider setting that means the same thing everywhere and can be named
// here rather than in an adapter.
//
// It is derived rather than restated. The levels are the SDK's to define, and a copy of them here
// would go stale the day it adds one, silently narrowing what a caller may ask for.
export type Effort = NonNullable<LanguageModelV4CallOptions["reasoning"]>

// What one request may set beyond the conversation. Only settings that mean the same thing on every
// provider are named here. Everything else is a provider's own vocabulary, and it travels in
// `providerOptions` under that provider's key, where it stays typed and stays attributed: a service
// tier is one vendor's word for one vendor's queue, and a field here would imply otherwise.
export interface RequestOptions {
  readonly reasoning?: Effort
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: ProviderOptions
}

export class RequestOptionsProjection extends Context.Service<
  RequestOptionsProjection,
  Projection<RequestOptions>
>()("flamecast/RequestOptionsProjection") {}

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<NativeToolSpec>
  readonly options?: RequestOptions
}

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  // Present when the figure is known: the provider reported it, including zero, or a price table
  // filled it from token counts. Absent when nobody could say. That absence is unknown cost.
  readonly costUsd?: number
}

export interface Spend extends Usage {
  readonly settled: Usage
  readonly unsettled: Usage
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }

export interface ModelPricing {
  readonly promptUsdPerToken: number
  readonly completionUsdPerToken: number
}

export const costOf = (
  pricing: ModelPricing | undefined,
  promptTokens: number,
  completionTokens: number
): number | undefined =>
  pricing === undefined
    ? undefined
    : promptTokens * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken

export const priced = (usage: Usage, pricing?: ModelPricing): Usage => {
  if (usage.costUsd !== undefined) return usage
  const costUsd = costOf(pricing, usage.promptTokens, usage.completionTokens)
  return costUsd === undefined ? usage : { ...usage, costUsd }
}

// What a request could cost before it has answered. It is an upper bound rather than a guess: the
// prompt is known exactly, and the answer is bounded by the ceiling the request states. A
// reservation that counted no completion would under-record every attempt that died mid-answer,
// which is the one case the reservation exists to record.
export const reservedUsage = (
  request: ModelRequest,
  pricing?: ModelPricing,
  maxOutputTokens?: number
): Usage =>
  priced(
    {
      promptTokens: requestTokens(request),
      completionTokens: request.options?.maxOutputTokens ?? maxOutputTokens ?? 0
    },
    pricing
  )

// The size of a whole request, as the estimator reads it. The window is a bound on everything the
// model reads, so the estimate covers everything the request carries.
//
// Two callers ask this of the same request, one to reserve its spend and one to refuse it before it
// is sent, and serializing a long conversation twice to answer the same question is work nobody
// asked for. A request is a projection of the log and never mutated, so the answer is held against
// the object and released with it.
const sizes = new WeakMap<ModelRequest, number>()

export const requestTokens = (request: ModelRequest): number => {
  const held = sizes.get(request)
  if (held !== undefined) return held
  const size = estimateTextTokens(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools
    })
  )
  sizes.set(request, size)
  return size
}

export const settledUsage = (
  reported: unknown,
  reserved: Usage,
  pricing?: ModelPricing
): Usage => {
  if (reported === undefined) return ZERO_USAGE
  const usage = priced(usageOf(reported), pricing)
  if (usage.costUsd !== undefined || reserved.costUsd === undefined) return usage
  return { ...usage, costUsd: reserved.costUsd }
}

export const sumUsage = (parts: ReadonlyArray<Usage>): Usage => {
  if (parts.length === 0) return ZERO_USAGE
  let promptTokens = 0
  let completionTokens = 0
  let costUsd = 0
  let known = true
  for (const part of parts) {
    promptTokens += part.promptTokens
    completionTokens += part.completionTokens
    if (part.costUsd === undefined) known = false
    else costUsd += part.costUsd
  }
  return {
    promptTokens,
    completionTokens,
    ...(known ? { costUsd } : {})
  }
}

export const spendOf = (settled: Usage, unsettled: Usage): Spend => ({
  ...sumUsage([settled, unsettled]),
  settled,
  unsettled
})

export type Action =
  | {
      readonly kind: "call"
      readonly callId: string
      readonly name: string
      readonly arguments: unknown
      readonly text?: string | undefined
      readonly usage?: Usage | undefined
      readonly continuation?: ProviderContinuation | undefined
    }
  | {
      readonly kind: "complete"
      readonly output: string
      readonly usage?: Usage | undefined
      readonly continuation?: ProviderContinuation | undefined
    }
  | { readonly kind: "fail"; readonly error: string; readonly usage?: Usage | undefined }
  | {
      readonly kind: "defer"
      readonly error: string
      readonly retryAfterMs?: number | undefined
      readonly usage?: Usage | undefined
    }
  // An answer the provider stopped at its output ceiling. The fragment is what the model managed to
  // say, and `call` is the tool call it was partway through naming. The arguments are the raw
  // partial the provider sent, which is not JSON and is not meant to be parsed: it is recorded so a
  // module can read which tool was cut and decide what to do, rather than inferring it from prose.
  | {
      readonly kind: "truncated"
      readonly text: string
      readonly call?: { readonly name: string; readonly arguments: string } | undefined
      readonly usage?: Usage | undefined
      readonly continuation?: ProviderContinuation | undefined
    }

export interface InferenceState {
  readonly provider: string
  readonly model: string
  // How large a request the model accepts. The window belongs to the model rather than to the
  // framework, so nothing here supplies a figure: a provider is built with one or built by asking
  // the gateway for one, and either way it holds a number before it exists.
  //
  // It is required so that this projection stays a pure function of its provider and the log. A
  // window a provider learned mid-session would answer differently in a process that had made a call
  // and one that had not, and a machine guard reads this, so the same log would fold two ways and a
  // replay would diverge from the run it replays.
  readonly contextWindow: number
  // What the model costs, when a catalog or a caller has said. A figure written here would be wrong
  // for every model it was never measured against, so absence means the projection cannot price a
  // turn, and a missing provider cost stays unknown rather than becoming zero.
  readonly pricing?: ModelPricing
  // The ceiling on one answer, when the model or the caller has stated one. A reservation reads it
  // to bound what an attempt that never returned could have spent.
  readonly maxOutputTokens?: number
}

export interface InferenceProvider {
  readonly id: string
  readonly state: (log: ReadonlyArray<Event>) => InferenceState
  readonly react: (request: ModelRequest, key: string) => Effect.Effect<Action>
}

export type InferenceSelection =
  | InferenceProvider
  | ((log: ReadonlyArray<Event>) => InferenceProvider)

export const selectedInference = (
  selection: InferenceSelection,
  log: ReadonlyArray<Event>
): InferenceProvider => (typeof selection === "function" ? selection(log) : selection)

export interface CustomInferenceOptions {
  readonly id?: string
  readonly model?: string
  // What the model behind this function accepts. Required for the same reason the projection is:
  // whoever wrote the function is the only one who can say, and nobody downstream can guess.
  readonly contextWindow: number
  readonly pricing?: ModelPricing
  readonly maxOutputTokens?: number
}

export const customInference = (
  react: (request: ModelRequest, key: string) => Promise<Action>,
  options: CustomInferenceOptions
): InferenceProvider => {
  const model = options.model ?? "custom"
  return {
    id: options.id ?? `custom:${model}`,
    state: () => ({
      provider: options.id ?? "custom",
      model,
      contextWindow: options.contextWindow,
      ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens })
    }),
    react: (request, key) => Effect.promise(() => react(request, key))
  }
}

export class Infer extends Context.Service<Infer, InferenceProvider>()("flamecast/Infer") {}

export const inferWith = (
  react: (request: ModelRequest, key: string) => Promise<Action>,
  options: CustomInferenceOptions
): Layer.Layer<Infer> => Layer.succeed(Infer, customInference(react, options))

export const usageOf = (value: unknown): Usage => {
  const carried = value as Partial<Usage> | undefined
  return {
    promptTokens: typeof carried?.promptTokens === "number" ? carried.promptTokens : 0,
    completionTokens: typeof carried?.completionTokens === "number" ? carried.completionTokens : 0,
    ...(typeof carried?.costUsd === "number" ? { costUsd: carried.costUsd } : {})
  }
}
