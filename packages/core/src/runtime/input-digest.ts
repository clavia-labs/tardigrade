import { frozenPlainData } from "../atoms/incremental/frozen"
import { Buffer } from "node:buffer"
import { createHash, type Hash } from "node:crypto"
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

// canonicalForms caches the canonical text of verified frozen plain data, which cannot change after verification.
const canonicalForms = new WeakMap<object, string>()

// canonicalInput serializes JSON values with JCS property ordering and Unicode validation (RFC 8785 §3.2; inputCanonicalization).
export function canonicalInput(input: Schema.Json): string {
  if (typeof input === "string" && /[\uD800-\uDFFF]/u.test(input)) throw new Error("Canonical JSON rejects lone Unicode surrogates")
  if (typeof input === "number" && !Number.isFinite(input)) throw new Error("Canonical JSON requires finite numbers")
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  const cached = canonicalForms.get(input)
  if (cached !== undefined) return cached
  const text = Array.isArray(input)
    ? `[${input.map(canonicalInput).join(",")}]`
    : `{${Object.keys(input).sort().map(key => `${canonicalInput(key)}:${canonicalInput((input as Readonly<Record<string, Schema.Json>>)[key]!)}`).join(",")}}`
  if (frozenPlainData.has(input)) canonicalForms.set(input, text)
  return text
}

// ArrayPrefix is the hash state after a long array's elements, valid for a later array that starts with the same elements after the same leading text.
type ArrayPrefix = { readonly lead: string; readonly items: readonly unknown[]; readonly state: Hash; readonly bytes: number }
const arrayPrefixes: ArrayPrefix[] = []
const ARRAY_PREFIX_SLOTS = 8
const RESUMABLE_LEAD_CHARS = 256
const RESUMABLE_ARRAY_ITEMS = 16
const FLUSH_CHARS = 1 << 16

// digestInput identifies canonical JSON by SHA-256 and UTF-8 byte length (input-digest.test.ts). It hashes canonicalInput(input) as a stream, resuming a long array from the state of an earlier array that it extends, so a growing conversation hashes only its new messages.
export function digestInput(input: Schema.Json): InputDigest {
  let state = createHash("sha256"), bytes = 0, pending = ""
  let lead: string | undefined = ""
  const flush = () => { if (pending) { state.update(pending); bytes += Buffer.byteLength(pending); pending = "" } }
  const write = (text: string) => {
    pending += text
    if (lead !== undefined) lead = lead.length + text.length <= RESUMABLE_LEAD_CHARS ? lead + text : undefined
    if (pending.length >= FLUSH_CHARS) flush()
  }
  const visitArray = (items: readonly Schema.Json[], before: string) => {
    let resumed: ArrayPrefix | undefined
    for (const prefix of arrayPrefixes) {
      if (prefix.lead !== before || prefix.items.length > items.length || (resumed && resumed.items.length >= prefix.items.length)) continue
      let same = true
      for (let index = 0; index < prefix.items.length && same; index++) same = prefix.items[index] === items[index]
      if (same) resumed = prefix
    }
    let start = 0
    if (resumed) { state = resumed.state.copy(); bytes = resumed.bytes; pending = ""; start = resumed.items.length } else write("[")
    lead = undefined
    let immutable = true
    for (let index = start; index < items.length; index++) {
      const item = items[index]!
      if (typeof item !== "object" || item === null || !frozenPlainData.has(item)) immutable = false
      write(`${index > 0 ? "," : ""}${canonicalInput(item)}`)
    }
    if (immutable && (!resumed || resumed.items.length < items.length)) {
      flush()
      arrayPrefixes.unshift({ lead: before, items: Object.freeze(items.slice()), state: state.copy(), bytes })
      arrayPrefixes.length = Math.min(arrayPrefixes.length, ARRAY_PREFIX_SLOTS)
    }
    write("]")
  }
  const visit = (value: Schema.Json): void => {
    if (value === null || typeof value !== "object" || lead === undefined) return write(canonicalInput(value))
    if (Array.isArray(value)) return value.length >= RESUMABLE_ARRAY_ITEMS ? visitArray(value, lead) : write(canonicalInput(value))
    const record = value as Readonly<Record<string, Schema.Json>>
    write("{")
    Object.keys(record).sort().forEach((key, index) => { write(`${index > 0 ? "," : ""}${canonicalInput(key)}:`); visit(record[key]!) })
    write("}")
  }
  visit(input)
  flush()
  return { _tag: "InputDigest", sha256: state.digest("hex"), bytes }
}

// storeRequest encodes input with an explicit representation at the configured UTF-8 boundary (properties/runtime/input-representation.ts).
export function storeRequest(request: EffectRequest, minBytes = DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES): StoredEffectRequest {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error("Effect input digest minBytes must be a nonnegative safe integer")
  const digest = digestInput(request.input)
  return { act: request.act, input: digest.bytes < minBytes ? { _tag: "InlineInput", value: request.input } : digest }
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
