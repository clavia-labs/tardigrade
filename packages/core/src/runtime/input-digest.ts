import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import type { EffectRequest } from "./events"

export const DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES = 2 * 1024

export const InputDigest = Schema.TaggedStruct("InputDigest", {
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type InputDigest = typeof InputDigest.Type

export const isInputDigest = Schema.is(InputDigest)

// canonicalInput encodes JSON with sorted object keys and ordered arrays (input-digest.test.ts).
export function canonicalInput(input: Schema.Json): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalInput).join(",")}]`
  return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonicalInput((input as Readonly<Record<string, Schema.Json>>)[key]!)}`).join(",")}}`
}

// digestInput identifies canonical JSON by SHA-256 and UTF-8 byte length (input-digest.test.ts).
export function digestInput(input: Schema.Json): InputDigest {
  const encoded = new TextEncoder().encode(canonicalInput(input))
  return { _tag: "InputDigest", sha256: createHash("sha256").update(encoded).digest("hex"), bytes: encoded.byteLength }
}

// compactRequest retains inputs below minBytes and preserves existing digest records (input-digest.test.ts).
export function compactRequest(request: EffectRequest, minBytes = DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES): EffectRequest {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error("Effect input digest minBytes must be a nonnegative safe integer")
  if (isInputDigest(request.input)) return request
  const encoded = canonicalInput(request.input)
  const bytes = new TextEncoder().encode(encoded).byteLength
  return bytes < minBytes ? request : { executor: request.executor, input: { _tag: "InputDigest", sha256: createHash("sha256").update(encoded).digest("hex"), bytes } }
}

// sameRequest compares executors and inputs across inline and digest records (input-digest.test.ts).
export function sameRequest(left: EffectRequest, right: EffectRequest): boolean {
  if (left.executor !== right.executor) return false
  const leftDigest = isInputDigest(left.input)
  const rightDigest = isInputDigest(right.input)
  if (!leftDigest && !rightDigest) return isDeepStrictEqual(left.input, right.input)
  return isDeepStrictEqual(leftDigest ? left.input : digestInput(left.input), rightDigest ? right.input : digestInput(right.input))
}
