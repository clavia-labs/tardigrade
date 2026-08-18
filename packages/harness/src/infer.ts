import { Context, Effect, Layer } from "effect"
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
  readonly continuation?: ProviderContinuation
}

export interface RequestOptions {
  readonly serviceTier?: string
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly effort?: "low" | "medium" | "high"
  readonly routes?: ReadonlyArray<string>
  readonly body?: Readonly<Record<string, unknown>>
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

export const reservedUsage = (request: ModelRequest, pricing?: ModelPricing): Usage =>
  priced(
    {
      promptTokens: estimateTextTokens(
        JSON.stringify({
          system: request.system,
          messages: request.messages,
          tools: request.tools
        })
      ),
      completionTokens: 0
    },
    pricing
  )

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

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

// Per-request options overlay construction-time fields. The request is a projection of the log, so
// a tier policy is a fold rather than a mutable argument to `react`.
export const applyRequestOptions = (
  body: Readonly<Record<string, unknown>>,
  options: RequestOptions | undefined
): Readonly<Record<string, unknown>> => {
  if (options === undefined) return body
  const existing = recordOf(body.providerOptions) ?? {}
  return {
    ...body,
    ...(options.maxOutputTokens === undefined ? {} : { max_tokens: options.maxOutputTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.serviceTier === undefined ? {} : { service_tier: options.serviceTier }),
    ...(options.effort === undefined ? {} : { output_config: { effort: options.effort } }),
    ...(options.routes === undefined
      ? {}
      : {
          providerOptions: {
            ...existing,
            gateway: { ...recordOf(existing.gateway), only: options.routes }
          }
        }),
    ...options.body
  }
}

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
      ...(options.pricing === undefined ? {} : { pricing: options.pricing })
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
