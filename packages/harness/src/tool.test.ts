import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { jsonSchemaOf } from "./schema"
import { tool } from "./tool"

// One declaration is both halves. These tests pin the schema the model reads and the check that
// runs before the handler, since the compiler covers the third half in the type tests.

describe("jsonSchemaOf", () => {
  test("a struct declares its properties, its required fields, and no others", () => {
    const input = Schema.Struct({
      orderId: Schema.String.annotate({ description: "The order to look up." }),
      limit: Schema.optionalKey(Schema.Int),
      tags: Schema.Array(Schema.String),
      mode: Schema.Literals(["fast", "thorough"]),
      dryRun: Schema.Boolean
    })
    expect(jsonSchemaOf(input)).toEqual({
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

  test("a struct with only optional fields requires nothing", () => {
    expect(jsonSchemaOf(Schema.Struct({ note: Schema.optionalKey(Schema.String) }))).toEqual({
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
    input: Schema.Struct({ orderId: Schema.String, limit: Schema.optionalKey(Schema.Int) }),
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
    expect(String((result as { error: string }).error)).toContain("Missing key")
  })

  test("a field of the wrong type never reaches the handler", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: 4182 }))
    expect(String((result as { error: string }).error)).toContain("Expected string")
  })

  test("an invented field is refused rather than ignored", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: "4182", sneaky: true }))
    expect(String((result as { error: string }).error)).toContain("Expected no excess property")
  })

  test("an absent optional field is not an error", async () => {
    const result = await Effect.runPromise(lookup.run({ orderId: "4182", limit: 3 }))
    expect(result).toEqual({ invoice: "INV-4182", limit: 3 })
  })

  // Every failure is reported at once, so a model repairing an answer does not spend one turn per
  // field.
  test("every failure is reported together", async () => {
    const result = await Effect.runPromise(lookup.run({ limit: "three", sneaky: true }))
    const error = String((result as { error: string }).error)
    expect(error).toContain("Missing key")
    expect(error).toContain("Expected no excess property")
    expect(error).toContain("Expected number")
  })
})
