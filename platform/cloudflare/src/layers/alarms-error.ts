import { Data } from "effect"
import type { CloudflareErrorClassification } from "./error"

export type DurableObjectAlarmOperation = "getAlarm" | "setAlarm" | "deleteAlarm" | "sync"

export interface DurableObjectAlarmErrorClassification extends CloudflareErrorClassification {
  readonly retryable?: boolean
  readonly overloaded?: boolean
}

// DurableObjectAlarmError records a failed storage operation and its original cause.
export class DurableObjectAlarmError extends Data.TaggedError("DurableObjectAlarmError")<DurableObjectAlarmErrorClassification & {
  readonly operation: DurableObjectAlarmOperation
  readonly cause: unknown
}> {
  override get message(): string {
    return `DurableObjectAlarms.${this.operation}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// classifyDurableObjectAlarmError uses the flags documented at https://developers.cloudflare.com/durable-objects/best-practices/error-handling/; other failures remain unknown.
export const classifyDurableObjectAlarmError = (
  cause: unknown,
  _operation: DurableObjectAlarmOperation
): DurableObjectAlarmErrorClassification => {
  const error = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {}
  const code = typeof error.code === "string" || typeof error.code === "number" && Number.isFinite(error.code)
    ? error.code as string | number : undefined
  const rawStatus = nonNegativeNumber(error.status) ?? nonNegativeNumber(error.statusCode)
  const status = rawStatus !== undefined && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus : undefined
  const retryAfterMillis = nonNegativeNumber(error.retryAfterMillis)
  const retryable = typeof error.retryable === "boolean" ? error.retryable : undefined
  const overloaded = typeof error.overloaded === "boolean" ? error.overloaded : undefined
  return {
    classification: overloaded === true ? "unknown" : retryable === true ? "transient" : "unknown",
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(overloaded === undefined ? {} : { overloaded })
  }
}
