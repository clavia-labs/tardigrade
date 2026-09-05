import type { ModelMessage, StreamChunk, Tool } from "@tanstack/ai"
import type { InferenceIdentity } from "tardie/inference/observer"
import type { ModelRequest } from "tardie/inference/request"
import type { OutputMode } from "tardie/output/contract"
import type { UsageAdapter } from "tardie/inference/usage"
import type { ModelProtocol } from "./directory"
import type { OutputCapability } from "./output"

export interface StreamBounds {
  readonly firstChunkMs: number
  readonly idleMs: number
  readonly totalMs: number
}

export type ModelFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
) => Promise<Response>

export interface ModelConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly protocol: ModelProtocol
  readonly provider: string
  // region selects the AWS region for a Bedrock Converse connection.
  readonly region?: string
  readonly contextWindowTokens: number
  // maxOutputTokens caps every truncation-ladder rung; an omitted value uses the exported ladder.
  readonly maxOutputTokens?: number
  // maxTokensLadder replaces the exported truncation ladder before maxOutputTokens bounds it.
  readonly maxTokensLadder?: ReadonlyArray<number>
  // stream replaces any stated fields in DEFAULT_STREAM_BOUNDS.
  readonly stream?: Partial<StreamBounds>
  // output states the endpoint guarantee; an omitted value promises no native contract support.
  readonly output?: OutputCapability
  // usageAdapter interprets raw reports for this binding; omission preserves raw data with unknown metrics (model.test.ts, "raw usage stays uninterpreted without an adapter").
  readonly usageAdapter?: UsageAdapter
  // pricing is rejected at construction; explicit adapters can call priced (model.test.ts, "implicit pricing is rejected before dispatch").
  readonly pricing?: never
  // throttleRetryDelaysMs sets the backoff bases and its length sets the retry count.
  readonly throttleRetryDelaysMs?: ReadonlyArray<number>
  // retryAfterJitterMs adds a random wait to a provider Retry-After value.
  readonly retryAfterJitterMs?: number
  // fetch replaces the transport for an embedding or test.
  readonly fetch?: ModelFetch
  // sleep replaces the retry wait for an embedding or test.
  readonly sleep?: (ms: number) => Promise<void>
}

export type ModelStopClass = "refused" | "truncated" | "violation" | "ok"

export interface ModelAdapterContext {
  readonly config: ModelConfig
  readonly request: ModelRequest
  // identity names the actor turn this attempt serves, so an adapter can attribute usage and authorize per instance (model.test.ts, "an adapter start receives the request's inference identity").
  readonly identity: InferenceIdentity
  readonly mode: OutputMode
  readonly maxTokens: number
  readonly bounds: StreamBounds
  readonly fetch: ModelFetch
  readonly messages: ReadonlyArray<ModelMessage>
  readonly tools: ReadonlyArray<Tool>
  readonly systemPrompts: ReadonlyArray<string>
}

export interface ModelAdapterAttempt {
  readonly stream: AsyncIterable<StreamChunk>
  readonly reportedUsage?: () => unknown
  readonly stopClass?: () => ModelStopClass
  readonly finishReason?: () => string | undefined
}

export interface ModelAdapter {
  readonly id: string
  // ModelAdapter protocols select wire implementations independently of provider and model identity (adapter.test.ts, "resolves each protocol to its registered implementation").
  readonly protocols: ReadonlyArray<ModelProtocol>
  readonly start: (context: ModelAdapterContext) => ModelAdapterAttempt
}

export interface ModelAdapterRegistry {
  readonly protocols: ReadonlyArray<ModelProtocol>
  readonly resolve: (protocol: ModelProtocol) => ModelAdapter
}

// modelAdapters constructs an immutable protocol registry and rejects ambiguous implementations.
export const modelAdapters = (...adapters: ReadonlyArray<ModelAdapter>): ModelAdapterRegistry => {
  const byProtocol = new Map<ModelProtocol, ModelAdapter>()
  for (const adapter of adapters) {
    for (const protocol of adapter.protocols) {
      const previous = byProtocol.get(protocol)
      if (previous !== undefined) {
        throw new Error(`model protocol ${JSON.stringify(protocol)} has adapters ${JSON.stringify(previous.id)} and ${JSON.stringify(adapter.id)}`)
      }
      byProtocol.set(protocol, adapter)
    }
  }
  const protocols = Object.freeze([...byProtocol.keys()])
  return Object.freeze({
    protocols,
    resolve: (protocol: ModelProtocol): ModelAdapter => {
      const adapter = byProtocol.get(protocol)
      if (adapter !== undefined) return adapter
      throw new Error(
        `model protocol ${JSON.stringify(protocol)} has no registered adapter; register one with modelAdapters(...) before starting the host`
      )
    }
  })
}
