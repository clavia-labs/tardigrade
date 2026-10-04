import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import * as fc from "fast-check"
import { EffectAcceptance, StoredEffectRequested, effectKey, createRecordSource, createStore } from "@clavia/tardigrade-core"
import { canonicalInput, digestInput, matchesRequest, sameStoredRequest, observeRequest, storeRequest } from "../../../../core/src/runtime/input-digest"

const name = fc.string({ minLength: 1, maxLength: 24 })
const json = fc.oneof(fc.jsonValue(), fc.constant(-0), fc.constant(digestInput("user data")), fc.constant({ _tag: "InlineInput", value: "user data" })).map(Schema.decodeUnknownSync(Schema.Json))
const decodeStored = Schema.decodeUnknownSync(StoredEffectRequested, { onExcessProperty: "error" })
const decodeAcceptance = Schema.decodeUnknownSync(EffectAcceptance, { onExcessProperty: "error" })

// inputRepresentation checks encoding, observation, and verification across arbitrary inputs and atom coordinates (quint/checkpoint/inputLifecycle.qnt).
export const inputRepresentation = fc.property(fc.record({
  input: json, act: name,
  ref: fc.record({ seq: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 1 }), atom: name, tag: name }),
}), ({ input, act, ref: coordinate }) => {
  const ref = { ...coordinate }
  const proposal = { act: act, input }
  const digest = digestInput(input)
  const before = canonicalInput(proposal)
  const expected = { type: "EffectRequested" as const, ref, act }
  for (const minBytes of [0, digest.bytes, digest.bytes + 1]) {
    const request = storeRequest(proposal, minBytes)
    const record = decodeStored(JSON.parse(JSON.stringify({ type: "EffectRequested", ref, request })))
    if (!isDeepStrictEqual(record.ref, expected.ref) || !matchesRequest(record.request, proposal) || !sameStoredRequest(record.request, storeRequest(proposal, 0))) throw new Error("Stored request failed round-trip verification")
    if (record.request.input._tag !== (minBytes <= digest.bytes ? "InputDigest" : "InlineInput")) throw new Error("UTF-8 threshold changed representation at the wrong boundary")
    const observed = observeRequest(record)
    if (!isDeepStrictEqual(decodeAcceptance(observed), expected) || Object.keys(observed).sort().join(",") !== "act,ref,type") throw new Error("Acceptance exposed stored payload")
    if (matchesRequest(record.request, { act: `${act}/changed`, input }) || matchesRequest(record.request, { act: act, input: [input] })) throw new Error("Mismatched reconstruction passed verification")
    if (record.request.input._tag === "InputDigest" && matchesRequest({ ...record.request, input: { ...record.request.input, bytes: digest.bytes + 1 } }, proposal)) throw new Error("Digest byte mismatch passed verification")
  }
  const source = createRecordSource()
  const store = createStore()
  try {
    const original = { type: "EffectRequested" as const, ref, request: storeRequest(proposal, Number.MAX_SAFE_INTEGER) }
    for (const request of [original, { ...original, request: storeRequest(proposal, 0) }]) {
      const previous = store.get(source.observedRecords)
      source.append(store, [{ event: request, recordedAt: ref.seq }])
      const observed = store.get(source.observedRecords).at(-1)!
      if (!isDeepStrictEqual(observed, { event: expected, recordedAt: ref.seq }) || !isDeepStrictEqual(store.get(source.observedEvents).at(-1), expected)) throw new Error("Atom source exposed payload or lost metadata")
      if (!Object.isFrozen(observed.event) || store.get(source.records).at(-1)!.event !== request || previous.length !== store.get(source.observedRecords).length - 1) throw new Error("Observation mutated the stored prefix")
    }
  } finally { store.dispose() }
  const changedInput = observeRequest({ type: "EffectRequested", ref, request: storeRequest({ act: act, input: [input] }, 0) })
  if (!isDeepStrictEqual(changedInput, expected)) throw new Error("Input changed acceptance observation")
  if (canonicalInput(proposal) !== before) throw new Error("Encoding mutated the live proposal")
  for (const other of [{ ...ref, seq: ref.seq + 1 }, { ...ref, atom: `${ref.atom}/other` }, { ...ref, tag: `${ref.tag}/other` }]) {
    if (effectKey(ref) === effectKey(other)) throw new Error("Distinct coordinates share identity")
  }
  if (canonicalInput({ z: input, a: "é" }) !== canonicalInput({ a: "é", z: input })) throw new Error("Object key order changed canonical input")
})


// inputCanonicalization checks RFC 8785 §3.2.3 ordering and Appendix B number vectors on every host.
export function inputCanonicalization() {
  const keys = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"]
  const object = Object.fromEntries([...keys].reverse().map(key => [key, key]))
  const expected = `{${keys.map(key => `${JSON.stringify(key)}:${JSON.stringify(key)}`).join(",")}}`
  if (canonicalInput(object) !== expected) throw new Error("RFC 8785 UTF-16 ordering failed")
  if (canonicalInput({ "2": 2, "10": 10 }) !== '{"10":10,"2":2}') throw new Error("Integer-like keys escaped JCS ordering")
  const sample = "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"\u20ac$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
  if (canonicalInput(JSON.parse(sample)) !== sample) throw new Error("RFC 8785 serialization sample changed bytes")
  const numbers: readonly (readonly [string, string | null])[] = [
    ["0000000000000000", "0"], ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"], ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"], ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"], ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["7fffffffffffffff", null], ["7ff0000000000000", null],
    ["44b52d02c7e14af5", "9.999999999999997e+22"], ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"], ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"], ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"], ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"], ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"], ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ]
  const view = new DataView(new ArrayBuffer(8))
  for (const [bits, expected] of numbers) {
    view.setBigUint64(0, BigInt(`0x${bits}`))
    const input = view.getFloat64(0)
    if (expected === null) rejectsCanonicalInput(input)
    else if (canonicalInput(input) !== expected) throw new Error(`RFC 8785 number serialization failed: ${bits}`)
  }
  for (const input of ["\ud800", "\udfff", ["\ud800"], { ["\udfff"]: "value" }]) rejectsCanonicalInput(input)
}

function rejectsCanonicalInput(input: Schema.Json) {
  try { canonicalInput(input) } catch { return }
  throw new Error("Invalid JCS input was accepted")
}
