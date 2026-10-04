import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import type { EffectRequest } from "./events"
import type { EffectAcceptance, StoredEffectRequest, StoredEffectRequested } from "./effect-request"

export const DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES = 2 * 1024

export const InputDigest = Schema.TaggedStruct("InputDigest", {
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type InputDigest = typeof InputDigest.Type

// canonicalInput serializes JSON values with JCS property ordering and Unicode validation (RFC 8785 §3.2; inputCanonicalization).
export function canonicalInput(input: Schema.Json): string {
  if (typeof input === "string" && /[\uD800-\uDFFF]/u.test(input)) throw new Error("Canonical JSON rejects lone Unicode surrogates")
  if (typeof input === "number" && !Number.isFinite(input)) throw new Error("Canonical JSON requires finite numbers")
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalInput).join(",")}]`
  return `{${Object.keys(input).sort().map(key => `${canonicalInput(key)}:${canonicalInput((input as Readonly<Record<string, Schema.Json>>)[key]!)}`).join(",")}}`
}

// digestInput identifies canonical JSON by SHA-256 and UTF-8 byte length (input-digest.test.ts).
export function digestInput(input: Schema.Json): InputDigest {
  return digestBytes(new TextEncoder().encode(canonicalInput(input)))
}

const digestBytes = (encoded: Uint8Array): InputDigest => ({
  _tag: "InputDigest", sha256: createHash("sha256").update(encoded).digest("hex"), bytes: encoded.byteLength,
})

// storeRequest encodes input with an explicit representation at the configured UTF-8 boundary (properties/runtime/input-representation.ts).
export function storeRequest(request: EffectRequest, minBytes = DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES): StoredEffectRequest {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error("Effect input digest minBytes must be a nonnegative safe integer")
  const encoded = new TextEncoder().encode(canonicalInput(request.input))
  return { act: request.act, input: encoded.byteLength < minBytes
    ? { _tag: "InlineInput", value: request.input } : digestBytes(encoded) }
}

// observeRequest projects acceptance without copying stored input (quint/checkpoint/inputLifecycle.qnt, observationIndependent).
export function observeRequest(record: StoredEffectRequested): EffectAcceptance {
  return { type: record.type, ref: record.ref, act: record.request.act, ...(record.origin === undefined ? {} : { origin: record.origin }) }
}

// matchesRequest validates the act and reconstructed input across storage representations (properties/runtime/input-representation.ts).
export function matchesRequest(stored: StoredEffectRequest, proposal: EffectRequest): boolean {
  if (stored.act !== proposal.act) return false
  if (stored.input._tag === "InlineInput") return canonicalInput(stored.input.value) === canonicalInput(proposal.input)
  return isDeepStrictEqual(stored.input, digestInput(proposal.input))
}

// sameStoredRequest compares accepted declarations independently of their representation (inputRepresentation).
export function sameStoredRequest(left: StoredEffectRequest, right: StoredEffectRequest): boolean {
  return left.act === right.act && isDeepStrictEqual(left.input._tag === "InputDigest" ? left.input : digestInput(left.input.value), right.input._tag === "InputDigest" ? right.input : digestInput(right.input.value))
}
