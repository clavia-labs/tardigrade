import { Context, Effect, Layer } from "effect"
import type { Envelope } from "@flamecast/core"

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export interface ToolContext {
  readonly turn: string
  readonly callId: string
}

export interface Tool<R = never> {
  readonly spec: ToolSpec
  readonly run: (
    input: unknown,
    context?: ToolContext
  ) => Effect.Effect<unknown, never, R>
}

export interface AgentToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string | null
  readonly toolCalls?: ReadonlyArray<AgentToolCall>
  readonly toolCallId?: string
}

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolSpec>
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
    }
  | { readonly kind: "complete"; readonly output: string; readonly usage?: Usage | undefined }
  | { readonly kind: "fail"; readonly error: string; readonly usage?: Usage | undefined }

export interface InferenceState {
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
}

export interface InferenceProvider {
  readonly id: string
  readonly state: (log: ReadonlyArray<Envelope>) => InferenceState
  readonly react: (request: ModelRequest, key: string) => Effect.Effect<Action>
}

export type InferenceSelection =
  | InferenceProvider
  | ((log: ReadonlyArray<Envelope>) => InferenceProvider)

export const selectedInference = (
  selection: InferenceSelection,
  log: ReadonlyArray<Envelope>
): InferenceProvider => (typeof selection === "function" ? selection(log) : selection)

export interface CustomInferenceOptions {
  readonly id?: string
  readonly model?: string
  readonly contextWindow?: number
}

export const customInference = (
  react: (request: ModelRequest, key: string) => Promise<Action>,
  options: CustomInferenceOptions = {}
): InferenceProvider => {
  const model = options.model ?? "custom"
  return {
    id: options.id ?? `custom:${model}`,
    state: () => ({
      provider: options.id ?? "custom",
      model,
      contextWindow: options.contextWindow ?? 128_000
    }),
    react: (request, key) => Effect.promise(() => react(request, key))
  }
}

export class Infer extends Context.Tag("flamecast/Infer")<Infer, InferenceProvider>() {}

export const inferWith = (
  react: (request: ModelRequest, key: string) => Promise<Action>,
  options: CustomInferenceOptions = {}
): Layer.Layer<Infer> => Layer.succeed(Infer, customInference(react, options))

export const usageOf = (value: unknown): Usage => {
  const carried = value as Partial<Usage> | undefined
  return {
    promptTokens: typeof carried?.promptTokens === "number" ? carried.promptTokens : 0,
    completionTokens: typeof carried?.completionTokens === "number" ? carried.completionTokens : 0,
    costUsd: typeof carried?.costUsd === "number" ? carried.costUsd : 0
  }
}
