import { Redacted, Schema } from "effect"
import { AiError } from "effect/unstable/ai"
import { Headers } from "effect/unstable/http"

export const ModelError = Schema.toCodecJson(AiError.AiError)
export type ModelError = typeof ModelError.Type

export const DEFAULT_MODEL_ERROR_REDACTED_HEADERS: ReadonlyArray<string | RegExp> = Object.freeze([
  "authorization", "proxy-authorization", "x-bf-vk", "x-api-key", "api-key", "cookie", "set-cookie", /token|secret/i,
])

const redactHeaders = (headers: typeof AiError.HttpRequestDetails.Type["headers"], names: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name,
    Headers.isRedactedName(name, names) || Redacted.isRedacted(value) ? "[REDACTED]" : value,
  ]))

export const encodeModelError = (error: AiError.AiError, redactedHeaders: ReadonlyArray<string | RegExp> = DEFAULT_MODEL_ERROR_REDACTED_HEADERS): Schema.Json => {
  const object = Schema.Record(Schema.String, Schema.Json)
  const encoded = Schema.decodeUnknownSync(object)(Schema.encodeSync(ModelError)(error))
  const reason = encoded.reason
  if ("http" in error.reason && error.reason.http !== undefined && Schema.is(object)(reason)) {
    const context = error.reason.http
    const http = Schema.decodeUnknownSync(Schema.Json)(
      JSON.parse(Schema.encodeSync(Schema.fromJsonString(AiError.HttpContext))({
        ...context,
        request: { ...context.request, headers: redactHeaders(context.request.headers, redactedHeaders) },
        ...(context.response === undefined ? {} : { response: { ...context.response, headers: redactHeaders(context.response.headers, redactedHeaders) } }),
      }))
    )
    return { ...encoded, reason: { ...Schema.decodeSync(object)(reason), http } }
  }
  if (error.reason._tag === "NetworkError" && Schema.is(object)(reason)) {
    const request = Schema.encodeSync(Schema.toCodecJson(AiError.HttpRequestDetails))({
      ...error.reason.request, headers: redactHeaders(error.reason.request.headers, redactedHeaders),
    })
    return { ...encoded, reason: { ...Schema.decodeSync(object)(reason), request } }
  }
  return encoded
}

// unknownModelError preserves serializable evidence from unclassified failures.
export const unknownModelError = (cause: unknown): AiError.AiError => {
  if (AiError.isAiError(cause)) return cause
  const description = cause instanceof Error ? cause.message || cause.name : typeof cause === "string" ? cause : typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string" ? cause.message : "Model inference failed"
  const evidence = cause instanceof Error
    ? { ...Object.fromEntries(Object.entries(cause).filter(([, value]) => Schema.is(Schema.Json)(value))), name: cause.name, message: cause.message, ...(cause.stack === undefined ? {} : { stack: cause.stack }) }
    : Schema.is(Schema.Json)(cause) ? cause : String(cause)
  return AiError.make({ module: "Tardigrade", method: "inference", reason: AiError.UnknownError.make({ description, metadata: { tardigrade: { evidence } } }) })
}

// modelErrorOf decodes persisted native evidence; historical envelopes remain historical.
export const modelErrorOf = (error: unknown): AiError.AiError | undefined => {
  if (AiError.isAiError(error)) return error
  const decoded = Schema.decodeUnknownOption(ModelError)(error)
  return decoded._tag === "Some" ? decoded.value : undefined
}
