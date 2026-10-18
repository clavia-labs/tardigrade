import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { decodeNode, digest, matchNode, freezeJson, type Json } from "../src/storage/nodes"

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

test("JSON string byte counts match stringify for escapes, Unicode and lone surrogates", () => {
  const values = ["", '"\\/\b\t\n\f\r', "hé漢字😀\u2028\u2029", "\ud800", "\udfff", "\ud800\ud800\udfff\udfff", "x".repeat(200000), Array.from({length: 32}, (_, index) => String.fromCharCode(index)).join("")]
  for (const value of values) expect(decodeNode(digest(JSON.stringify([4, "v", value])), JSON.stringify([4, "v", value])).logicalBytes).toBe(size(value))
  const utf16 = fc.array(fc.integer({ min: 0, max: 65535 }), {maxLength: 256}).map(codes => String.fromCharCode(...codes))
  fc.assert(fc.property(utf16, value => expect(decodeNode(digest(JSON.stringify([4, "v", value])), JSON.stringify([4, "v", value])).logicalBytes).toBe(size(value))), {includeErrorInReport: true, numRuns: 1000})
})

test("parsed JSON measurement matches canonical serialization and freezes nested values", () => {
  fc.assert(fc.property(fc.jsonValue(), raw => {
    const value: unknown = JSON.parse(JSON.stringify(raw))
    expect(decodeNode(digest(JSON.stringify([4, "v", value])), JSON.stringify([4, "v", value])).logicalBytes).toBe(size(value))
    const frozen = (value: unknown): void => {
      if (value !== null && typeof value === "object") { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
    }
    const text = JSON.stringify([4, "v", value])
    frozen(decodeNode(digest(text), text).payload)
  }), {includeErrorInReport: true, numRuns: 1000})
})

test("canonical size and authentication hold for arbitrary stored spellings", () => {
  fc.assert(fc.property(fc.jsonValue(), fc.constantFrom(3, 4), fc.boolean(), fc.nat(), (raw, version, spaced, delta) => {
    const value = JSON.parse(JSON.stringify(raw)) as Json
    const text = JSON.stringify([version, "v", value], null, spaced ? 2 : undefined)
    const hash = digest(text), node = decodeNode(hash, text)
    expect(node.logicalBytes).toBe(size(value))
    expect(node.payload).toEqual(value)
    expect(() => matchNode({ ...node, logicalBytes: node.logicalBytes + delta + 1 }, node)).toThrow("metadata mismatch")
    expect(() => decodeNode(hash, text + " ")).toThrow("corrupt")
    for (const invalid of [undefined, Infinity, NaN, { x: Infinity }, [NaN]]) expect(() => freezeJson(invalid)).toThrow("finite")
  }), { includeErrorInReport: true, numRuns: 300 })
})
