import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  contractOf,
  correctionText,
  decodeOutput,
  output,
  outputErrors,
  outputProfileErrors,
  OUTPUT_SCHEMA_DEPTH,
  OUTPUT_STRING_FORMATS
} from "./output"

const SCOUT = output({
  name: "scout",
  schema: {
    type: "object",
    properties: {
      aspects: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"],
          additionalProperties: false
        }
      }
    },
    required: ["aspects"],
    additionalProperties: false
  }
})

describe("the supported profile", () => {
  test("a profile schema passes, and the contract carries its identity", () => {
    expect(outputProfileErrors(SCOUT.schema)).toEqual([])
    expect(SCOUT.name).toBe("scout")
  })

  // Each rule below is a rule a binding cannot honour. An optional property is widened to accept
  // null and an open object is closed before either wire sends it, so the provider would be
  // constrained by a schema this repository never declared, and local validation would then
  // reject a response the provider was told to give.
  test("an unlisted property is out of profile: the wire would widen it to accept null", () => {
    const problems = outputProfileErrors({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false
    })
    expect(problems.join(" ")).toContain('required must list every property; missing "b"')
  })

  test("an open object is out of profile: the wire would close it", () => {
    expect(outputProfileErrors({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }).join(" ")).toContain(
      "additionalProperties false"
    )
  })

  test("a combinator or a reference cannot be sent strict at all", () => {
    for (const keyword of ["oneOf", "allOf", "not", "$ref", "$defs"]) {
      const problems = outputProfileErrors({
        type: "object",
        properties: { a: { type: "string", [keyword]: [] } },
        required: ["a"],
        additionalProperties: false
      })
      expect(problems.join(" ")).toContain(`${keyword} is outside the profile`)
    }
  })

  test("a typeless node is out of profile: strict mode rejects the request", () => {
    const problems = outputProfileErrors({
      type: "object",
      properties: { a: {} },
      required: ["a"],
      additionalProperties: false
    })
    expect(problems.join(" ")).toContain("every schema declares one type")
  })

  test("only the allowlisted string formats survive the wire, so only those are in profile", () => {
    for (const format of OUTPUT_STRING_FORMATS) {
      expect(
        outputProfileErrors({ type: "object", properties: { a: { type: "string", format } }, required: ["a"], additionalProperties: false })
      ).toEqual([])
    }
    expect(
      outputProfileErrors({
        type: "object",
        properties: { a: { type: "string", format: "uri" } },
        required: ["a"],
        additionalProperties: false
      }).join(" ")
    ).toContain('format "uri" is outside the profile')
  })

  test("a schema that points at itself is refused rather than walked forever", () => {
    // A model-authored schema is a value nobody proved is a tree (spawn.ts, outputAsked).
    const cyclic: Record<string, unknown> = { type: "object", required: ["self"], additionalProperties: false }
    cyclic["properties"] = { self: cyclic }
    expect(outputProfileErrors(cyclic).join(" ")).toContain(`nests deeper than the ${OUTPUT_SCHEMA_DEPTH}-level bound`)
  })

  test("the bound is the caller's, and a deeper schema states its own", () => {
    const nested = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } }, required: ["b"], additionalProperties: false } },
      required: ["a"],
      additionalProperties: false
    }
    expect(outputProfileErrors(nested)).toEqual([])
    expect(outputProfileErrors(nested, 1).join(" ")).toContain("nests deeper than")
  })

  test("the root is an object schema, because that is what both response formats take", () => {
    expect(outputProfileErrors({ type: "array", items: { type: "string" } })).toEqual([
      "/: the declared output is an object schema"
    ])
    expect(outputProfileErrors("nonsense")).toHaveLength(1)
  })

  test("output refuses an out-of-profile schema and a name no wire can carry", () => {
    expect(() =>
      output({
        name: "loose",
        // The type rejects this at a call site; a JavaScript caller reaches the same rule here.
        schema: { type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: false } as never
      })
    ).toThrow("outside the supported schema profile")
    expect(() => output({ name: "not a name", schema: { type: "object", properties: {}, required: [], additionalProperties: false } })).toThrow(
      "must match"
    )
  })
})

describe("validation", () => {
  test("a conforming value has no errors, and a strict provider is still checked", () => {
    expect(outputErrors(SCOUT.schema, { aspects: [{ name: "a", description: "b" }] })).toEqual([])
    expect(outputErrors(undefined, { anything: true })).toEqual([])
  })

  test("the double-encoded answer is caught, and the reason names the field", () => {
    const errors = outputErrors(SCOUT.schema, { aspects: JSON.stringify({ aspects: [] }) })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(" ")).toContain("aspects")
  })

  test("a missing required field and a wrong item shape are both caught", () => {
    expect(outputErrors(SCOUT.schema, {}).length).toBeGreaterThan(0)
    expect(outputErrors(SCOUT.schema, { aspects: [{ name: "a" }] }).length).toBeGreaterThan(0)
  })

  test("a schema the validator cannot build reads as a contract error, never a death", () => {
    const errors = outputErrors({ $ref: "#/nowhere" }, { a: 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("invalid schema")
  })

  test("decodeOutput separates a response that is not JSON from one that misses the schema", () => {
    expect(decodeOutput(SCOUT, JSON.stringify({ aspects: [] }))).toEqual({ value: { aspects: [] }, errors: [] })
    expect(decodeOutput(SCOUT, "here are the aspects").errors.join(" ")).toContain("not JSON")
    expect(decodeOutput(SCOUT, JSON.stringify({ aspects: "one" })).errors.join(" ")).toContain("aspects")
  })

  test("the correction message carries every reason and names the encoding trap", () => {
    const text = correctionText(["/aspects: expected array", "/name: expected string"])
    expect(text).toContain("/aspects: expected array")
    expect(text).toContain("/name: expected string")
    expect(text).toContain("never a string holding one")
  })
})

describe("the declaration on the log", () => {
  test("the turn's head declares the contract; an undeclared turn has none", () => {
    const declared: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0", text: "older", at: 1 },
      { type: "MessageReceived", id: "m1", text: "go", output: { name: SCOUT.name, schema: SCOUT.schema }, at: 2 }
    ]
    expect(contractOf(declared)).toEqual({ name: "scout", schema: SCOUT.schema })
    expect(contractOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }])).toBeUndefined()
    expect(contractOf([])).toBeUndefined()
  })

  test("a declaration that is not a contract throws, because reading it as none accepts any answer", () => {
    expect(() => contractOf([{ type: "MessageReceived", id: "m1", text: "go", output: { type: "object" }, at: 1 }])).toThrow(
      "declares an output that is not a contract"
    )
  })
})
