import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { array, boolean, integer, literal, object, optional, string } from "./spec"
import { tool } from "./tool"

// One declaration is both halves. These tests pin the schema the model reads and the check that
// runs before the handler, since the compiler covers the third half in the type tests.

describe("spec", () => {
  test("an object declares its properties, its required fields, and no others", () => {
    const input = object({
      orderId: string("The order to look up."),
      limit: optional(integer()),
      tags: array(string()),
      mode: literal("fast", "thorough"),
      dryRun: boolean()
    })
    expect(input.json).toEqual({
      type: "object",
      properties: {
        orderId: { type: "string", description: "The order to look up." },
        limit: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["fast", "thorough"] },
        dryRun: { type: "boolean" }
      },
      required: ["orderId", "tags", "mode", "dryRun"],
      additionalProperties: false
    })
  })

  test("an object with only optional fields requires nothing", () => {
    expect(object({ note: optional(string()) }).json).toEqual({
      type: "object",
      properties: { note: { type: "string" } },
      additionalProperties: false
    })
  })
})

describe("tool", () => {
  const lookup = tool({
    name: "lookup_invoice",
    description: "Look up one invoice by order id.",
    input: object({ orderId: string(), limit: optional(integer()) }),
    run: (input) => Effect.succeed({ invoice: `INV-${input.orderId}`, limit: input.limit ?? 10 })
  })

  test("the schema the model reads is the schema the handler was typed against", () => {
    expect(lookup.spec).toEqual({
      name: "lookup_invoice",
      description: "Look up one invoice by order id.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" }, limit: { type: "integer" } },
        required: ["orderId"],
        additionalProperties: false
      }
    })
  })

  test("conforming arguments reach the handler", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: "4182" }))
    expect(result).toEqual({ invoice: "INV-4182", limit: 10 })
  })

  // A model can produce a well-formed call whose arguments miss the schema. The handler is typed
  // against that schema, so running it on those arguments would be reading a lie.
  test("a missing required field returns an error the model can repair", async () => {
    const result = await Effect.runPromise(lookup.run({}))
    expect(String((result as { error: string }).error)).toContain("/orderId: required")
  })

  test("a field of the wrong type never reaches the handler", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: 4182 }))
    expect(String((result as { error: string }).error)).toContain("expected string, got number")
  })

  test("an invented field is refused rather than ignored", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: "4182", sneaky: true }))
    expect(String((result as { error: string }).error)).toContain("/sneaky: not allowed here")
  })

  test("an absent optional field is not an error", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: "4182", limit: 3 }))
    expect(result).toEqual({ invoice: "INV-4182", limit: 3 })
  })
})
