import { Data } from "effect"
import type { CloudflareErrorClassification } from "./error"

export type R2Operation = "get" | "arrayBuffer" | "put"

export interface R2ErrorClassification extends CloudflareErrorClassification {
  readonly code?: number
}

// R2StorageError describes one failed attempt without asserting that a write is safe to repeat.
export class R2StorageError extends Data.TaggedError("R2StorageError")<R2ErrorClassification & {
  readonly operation: R2Operation
  readonly cause: unknown
}> {
  override get message(): string {
    return `R2.${this.operation}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

// statusByCode maps the Workers binding codes documented at https://developers.cloudflare.com/r2/api/error-codes/.
const statusByCode: Readonly<Record<number, number>> = {
  10001: 500, 10002: 401, 10003: 403, 10005: 400, 10006: 404,
  10007: 404, 10008: 409, 10009: 400, 10011: 400, 10012: 400,
  10013: 400, 10014: 400, 10018: 403, 10020: 400, 10024: 404,
  10025: 400, 10031: 412, 10033: 411, 10035: 403, 10037: 400,
  10039: 416, 10042: 403, 10043: 503, 10048: 400, 10054: 400,
  10058: 429, 10069: 403, 10073: 409, 100100: 400
}

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

// classifyR2Error uses binding codes and explicit transport metadata; unknown failures remain unclassified.
export const classifyR2Error = (cause: unknown, _operation: R2Operation): R2ErrorClassification => {
  const error = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {}
  const message = typeof error.message === "string" ? error.message : typeof cause === "string" ? cause : ""
  const suffix = /^(?:R2 )?(?:get|put):[\s\S]*\((\d+)\)\s*$/.exec(message)
  const rawCode = nonNegativeNumber(error.code) ?? (suffix === null ? undefined : Number(suffix[1]))
  const code = rawCode !== undefined && Number.isSafeInteger(rawCode) ? rawCode : undefined
  const explicitStatus = nonNegativeNumber(error.status) ?? nonNegativeNumber(error.statusCode)
  const status = explicitStatus !== undefined && Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
    ? explicitStatus : code === undefined ? undefined : statusByCode[code]
  const retryAfterMillis = nonNegativeNumber(error.retryAfterMillis)
  const networkFailure = error.code === "ECONNRESET" || error.code === "ECONNREFUSED"
    || error.code === "ETIMEDOUT" || error.code === "EPIPE" || error.code === "EAI_AGAIN"
    || error.name === "TimeoutError"
  const transient = code === 10054 || code === 10013 || networkFailure
    || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
  return {
    classification: transient ? "transient" : status !== undefined && status >= 400 && status < 500 ? "permanent" : "unknown",
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis })
  }
}
