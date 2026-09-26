import type { Schema } from "effect"
import type { StreamBounds } from "../stream/policy"

// BedrockModelOptions describes Converse settings validated by the Bedrock adapter (bedrock.test.ts).
export interface BedrockModelOptions {
  readonly toolHistory?: "native" | "text" | undefined
  readonly inferenceConfig?: {
    readonly maxTokens?: number | undefined
    readonly temperature?: number | undefined
    readonly topP?: number | undefined
    readonly stopSequences?: ReadonlyArray<string> | undefined
  } | undefined
  readonly guardrailConfig?: {
    readonly guardrailIdentifier?: string | undefined
    readonly guardrailVersion?: string | undefined
    readonly trace?: "disabled" | "enabled" | "enabled_full" | undefined
    readonly streamProcessingMode?: "async" | "sync" | undefined
  } | undefined
  readonly additionalModelRequestFields?: Schema.Json | undefined
  readonly promptVariables?: Readonly<Record<string, { readonly text: string } | { readonly $unknown: readonly [string, unknown] }>> | undefined
  readonly additionalModelResponseFieldPaths?: ReadonlyArray<string> | undefined
  readonly requestMetadata?: Readonly<Record<string, string>> | undefined
  readonly performanceConfig?: { readonly latency?: "optimized" | "standard" | undefined } | undefined
  readonly serviceTier?: { readonly type: "default" | "flex" | "priority" | "reserved" | undefined } | undefined
}

// BedrockConnection describes the shared host's connection to a Converse endpoint (bedrock.test.ts).
export interface BedrockConnection {
  readonly region?: string
  readonly endpoint?: string
  readonly token?: { readonly token: string; readonly expiration?: Date }
  readonly authSchemePreference?: Array<string>
}

// BedrockOptions carries shared provider settings without depending on the AWS SDK (bedrock.test.ts).
export interface BedrockOptions {
  readonly provider: "bedrock"
  readonly client: BedrockConnection
  readonly model: { readonly model: string; readonly config?: BedrockModelOptions }
  readonly gateway?: { readonly apiKey: string; readonly bounds: StreamBounds }
}
