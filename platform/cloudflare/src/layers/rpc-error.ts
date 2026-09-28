import { Data } from "effect"
import type { CloudflareErrorClassification } from "./error"

export type DurableObjectRpcStage = "lookup" | "call"

export interface DurableObjectRpcErrorClassification extends CloudflareErrorClassification {
  readonly retryable?: boolean
  readonly overloaded?: boolean
  readonly remote?: boolean
}

// DurableObjectRpcError records the failed stage and whether an acquired stub should be discarded.
export class DurableObjectRpcError extends Data.TaggedError("DurableObjectRpcError")<DurableObjectRpcErrorClassification & {
  readonly stage: DurableObjectRpcStage
  readonly operation: string
  readonly cause: unknown
  readonly stubRecreationRequired: boolean
}> {
  override get message(): string {
    return `DurableObjectRpc.${this.operation}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// classifyDurableObjectRpcError uses Cloudflare's flags (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/); other failures remain unknown.
export const classifyDurableObjectRpcError = (cause: unknown, _stage: DurableObjectRpcStage): DurableObjectRpcErrorClassification => {
  const error = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {}
  const code = typeof error.code === "string" || typeof error.code === "number" && Number.isFinite(error.code)
    ? error.code as string | number : undefined
  const rawStatus = nonNegativeNumber(error.status) ?? nonNegativeNumber(error.statusCode)
  const status = rawStatus !== undefined && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus : undefined
  const retryAfterMillis = nonNegativeNumber(error.retryAfterMillis)
  const retryable = typeof error.retryable === "boolean" ? error.retryable : undefined
  const overloaded = typeof error.overloaded === "boolean" ? error.overloaded : undefined
  const remote = typeof error.remote === "boolean" ? error.remote : undefined
  return {
    classification: overloaded === true ? "unknown" : retryable === true ? "transient" : "unknown",
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(overloaded === undefined ? {} : { overloaded }),
    ...(remote === undefined ? {} : { remote })
  }
}
