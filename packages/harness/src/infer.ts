import { Context, Effect, Layer } from "effect"
import type { Event } from "@flamecast/core"

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

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<NativeToolSpec>
}

export interface Usage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costUsd: number
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
      contextWindow: options.contextWindow
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
    costUsd: typeof carried?.costUsd === "number" ? carried.costUsd : 0
  }
}
