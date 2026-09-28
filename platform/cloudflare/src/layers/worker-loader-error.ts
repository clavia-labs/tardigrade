import { Data } from "effect"
import type { CloudflareErrorClassification } from "./error"

export type WorkerLoaderStage = "load" | "call" | "dispose"

export type WorkerLoaderErrorClassification = CloudflareErrorClassification

// WorkerLoaderError identifies the failed stage and retains its original cause.
export class WorkerLoaderError extends Data.TaggedError("WorkerLoaderError")<WorkerLoaderErrorClassification & {
  readonly stage: WorkerLoaderStage
  readonly operation: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `WorkerLoader.${this.operation}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

// classifyWorkerLoaderError retains explicit metadata without inferring retry safety from arbitrary Worker code failures.
export const classifyWorkerLoaderError = (cause: unknown, _stage: WorkerLoaderStage, _operation: string): WorkerLoaderErrorClassification => {
  const error = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {}
  const field = (name: string): unknown => {
    try { return error[name] } catch { return undefined }
  }
  const rawCode = field("code")
  const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode
    : typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : undefined
  const rawStatus = field("status") ?? field("statusCode")
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus : undefined
  const rawRetryAfterMillis = field("retryAfterMillis")
  const retryAfterMillis = typeof rawRetryAfterMillis === "number" && Number.isFinite(rawRetryAfterMillis)
    && rawRetryAfterMillis >= 0 ? rawRetryAfterMillis : undefined
  return {
    classification: "unknown",
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
}
