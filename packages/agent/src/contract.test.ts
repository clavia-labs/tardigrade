import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core/event"
import { answerErrors, outputSchemaOf, repairText } from "./contract"

const SCOUT = {
  type: "object",
  properties: {
    aspects: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" } },
        required: ["name", "description"]
      }
    }
  },
  required: ["aspects"]
}

describe("the turn's output contract", () => {
  test("the turn's head declares the schema; an undeclared turn has none", () => {
    const withSchema: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0", text: "older", at: 1 },
      { type: "MessageReceived", id: "m1", text: "go", output: SCOUT, at: 2 }
    ]
    expect(outputSchemaOf(withSchema)).toEqual(SCOUT)
    expect(outputSchemaOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }])).toBeUndefined()
    expect(outputSchemaOf([])).toBeUndefined()
  })

  test("a conforming answer has no errors", () => {
    expect(answerErrors(SCOUT, { aspects: [{ name: "a", description: "b" }] })).toEqual([])
    // Nothing declared means nothing to violate.
    expect(answerErrors(undefined, { anything: true })).toEqual([])
  })

  test("the double-encoded answer is caught, and the reason names the field", () => {
    const errors = answerErrors(SCOUT, { aspects: JSON.stringify({ aspects: [{ name: "a", description: "b" }] }) })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join(" ")).toContain("aspects")
  })

  test("a missing required field and a wrong item shape are both caught", () => {
    expect(answerErrors(SCOUT, {}).length).toBeGreaterThan(0)
    expect(answerErrors(SCOUT, { aspects: [{ name: "a" }] }).length).toBeGreaterThan(0)
  })

  test("a schema the validator cannot build reads as a contract error, never a death", () => {
    const errors = answerErrors({ $ref: "#/nowhere" }, { a: 1 })
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("invalid schema")
  })

  test("the repair message carries every reason and names the encoding trap", () => {
    const text = repairText(["/aspects: expected array", "/name: expected string"])
    expect(text).toContain("/aspects: expected array")
    expect(text).toContain("/name: expected string")
    expect(text).toContain("never a string holding one")
  })
})
