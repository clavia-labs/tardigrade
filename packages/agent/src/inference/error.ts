import { Schema } from "effect"
import { AiError } from "effect/unstable/ai"

export const ModelError = Schema.toCodecJson(AiError.AiError)
export type ModelError = typeof ModelError.Type

// encodeModelError preserves JSON duration encoding and native HTTP redaction (error.test.ts, packages/model/src/binding/errors.test.ts).
export const encodeModelError = (error: AiError.AiError): Schema.Json => {
  const object = Schema.Record(Schema.String, Schema.Json)
  const encoded = Schema.decodeUnknownSync(object)(Schema.encodeSync(ModelError)(error))
  const reason = encoded.reason
  if ("http" in error.reason && error.reason.http !== undefined && Schema.is(object)(reason)) {
    const http = Schema.decodeUnknownSync(Schema.Json)(
      JSON.parse(Schema.encodeSync(Schema.fromJsonString(AiError.HttpContext))(error.reason.http))
    )
    return { ...encoded, reason: { ...Schema.decodeUnknownSync(object)(reason), http } }
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
