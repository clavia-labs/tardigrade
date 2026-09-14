import assert from "node:assert/strict"
import type { ModelProtocol } from "../../../../packages/model/src/providers/directory"

export const DEFAULT_LIVE_TIMEOUT_MS = 240_000
export const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 8192
export const DEFAULT_LIVE_THINKING_TOKENS = 2048

type LiveBehavior = "completion" | "tool-loop" | "reasoning" | "recovery"

interface NativeEvidence {
  readonly opaqueParts: number
  readonly reasoningTokens: number
}

export interface ProtocolDriver {
  readonly protocol: ModelProtocol
  responseEvidence(body: string): NativeEvidence
  opaqueEvidence(body: string): ReadonlyArray<string>
  followUpEvidence(body: string, nonce: string): { readonly opaqueParts: number; readonly hasToolResult: boolean }
}

export interface LiveTarget {
  readonly id: string
  readonly protocol: ModelProtocol
  readonly credential: string
  readonly endpoint?: string
  readonly endpointEnv?: string
  readonly modelEnv: string
  readonly contextWindowEnv: string
  readonly regionEnv?: string
  readonly behaviors: ReadonlyArray<LiveBehavior>
}

export interface ResolvedLiveTarget extends LiveTarget {
  readonly endpoint: string
  readonly model: string
  readonly contextWindowTokens: number
  readonly apiKey: string
  readonly region?: string
}

export const positive = (name: string, fallback?: number): number => {
  const value = Number(process.env[name] ?? fallback)
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  return value
}

const required = (name: string): string => {
  const value = process.env[name]
  assert.ok(value, `Set ${name} to run this selected live target`)
  return value
}

export const resolveTarget = (target: LiveTarget): ResolvedLiveTarget => {
  const region = target.regionEnv === undefined ? undefined : required(target.regionEnv)
  const endpoint = (target.endpointEnv === undefined ? target.endpoint : process.env[target.endpointEnv]) ?? (target.protocol === "bedrock-converse" ? `https://bedrock-runtime.${region}.amazonaws.com` : undefined)
  assert.ok(endpoint, `Set ${target.endpointEnv} to run ${target.id}; this endpoint is intentionally local configuration`)
  return {
    ...target,
    endpoint,
    model: required(target.modelEnv),
    contextWindowTokens: positive(target.contextWindowEnv),
    apiKey: required(target.credential),
    ...(region === undefined ? {} : { region })
  }
}

export const selectedTargetIds = (): ReadonlyArray<string> => {
  const raw = process.env.TARDIE_LIVE_TARGETS
  return raw === undefined ? [] : raw.split(",").map((id) => id.trim()).filter(Boolean)
}
