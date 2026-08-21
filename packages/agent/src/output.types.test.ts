import { expect, test } from "bun:test"
import { output, type Decoded, type OutputContract, type OutputProblems } from "./output"

// The compile-time half of the contract. Every assertion here is checked by `bun run typecheck`,
// which fails on an unsatisfied `@ts-expect-error` as loudly as on a type error, so a schema that
// stops being rejected and a value that stops being inferred both break the gate. The runtime
// half is output.test.ts.
//
// The assertions sit inside functions nobody calls: a rejected `output` call throws at
// construction, and the values are declared rather than built.

// accepts asserts that its argument has the annotated type. The call is the assertion.
const accepts = <T>(_value: T): void => {}

const ASPECTS = output({
  name: "aspects",
  schema: {
    type: "object",
    properties: {
      aspects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            weight: { type: "number" },
            kind: { type: "string", enum: ["risk", "opportunity"] },
            note: { anyOf: [{ type: "string" }, { type: "null" }] }
          },
          required: ["name", "weight", "kind", "note"],
          additionalProperties: false
        }
      },
      done: { type: "boolean" }
    },
    required: ["aspects", "done"],
    additionalProperties: false
  }
})

type Value<C> = C extends OutputContract<infer T> ? T : never
type Aspects = Value<typeof ASPECTS>

// The schema decodes to the value, member by member, including the enum as a literal union and
// the null member as a nullable field.
export const decodes = (aspects: Aspects): void => {
  accepts<ReadonlyArray<string>>(aspects.aspects.map((a) => a.name))
  accepts<ReadonlyArray<number>>(aspects.aspects.map((a) => a.weight))
  accepts<ReadonlyArray<"risk" | "opportunity">>(aspects.aspects.map((a) => a.kind))
  accepts<ReadonlyArray<string | null>>(aspects.aspects.map((a) => a.note))
  accepts<boolean>(aspects.done)
  // @ts-expect-error an array of objects is not a string
  accepts<string>(aspects.aspects)
  // @ts-expect-error the enum admits two members and no other
  accepts<"risk">(aspects.aspects[0]!.kind)
  // @ts-expect-error a nullable field is not a bare string
  accepts<string>(aspects.aspects[0]!.note)
  accepts<Decoded<{
    readonly type: "object"
    readonly properties: { readonly a: { readonly type: "array"; readonly items: { readonly type: "integer" } } }
    readonly required: readonly ["a"]
    readonly additionalProperties: false
  }>>({ a: [1, 2] })
}

// A contract's value type erases in one direction only: a proven contract stands where an
// unproven one is asked for, and never the reverse.
export const erases = (proven: typeof ASPECTS, unproven: OutputContract): void => {
  accepts<OutputContract>(proven)
  // @ts-expect-error an unproven schema cannot stand in for a proven one
  accepts<OutputContract<Aspects>>(unproven)
}

// Out-of-profile schemas are rejected at the call site, each for a rule a binding cannot honour.
export const rejects = (): void => {
  output({
    name: "unlisted",
    // @ts-expect-error required must list every property, or the wire widens the rest to accept null
    schema: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "open",
    // @ts-expect-error an object declares additionalProperties false, or the wire closes it
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
  })
  output({
    name: "referenced",
    schema: {
      type: "object",
      // @ts-expect-error a reference cannot be sent strict
      properties: { a: { $ref: "#/x" } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "combined",
    schema: {
      type: "object",
      // @ts-expect-error a combinator cannot be sent strict
      properties: { a: { oneOf: [{ type: "string" }] } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "typeless",
    schema: {
      type: "object",
      // @ts-expect-error a typeless node is rejected by strict mode
      properties: { a: {} },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "formatted",
    schema: {
      type: "object",
      // @ts-expect-error only the allowlisted string formats survive the wire
      properties: { a: { type: "string", format: "uri" } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "rooted",
    // @ts-expect-error the root of a declared output is an object schema
    schema: { type: "array", items: { type: "string" } }
  })
}

// The rule reads the same at any depth, and an in-profile schema has no problems at all, so the
// guard adds nothing to a call site that obeys it.
type Nested = OutputProblems<{
  readonly type: "object"
  readonly properties: {
    readonly outer: {
      readonly type: "array"
      readonly items: {
        readonly type: "object"
        readonly properties: { readonly inner: { readonly type: "string" } }
        readonly required: readonly []
        readonly additionalProperties: false
      }
    }
  }
  readonly required: readonly ["outer"]
  readonly additionalProperties: false
}>

type Clean = OutputProblems<{
  readonly type: "object"
  readonly properties: { readonly a: { readonly type: "string" } }
  readonly required: readonly ["a"]
  readonly additionalProperties: false
}>

export const reports = (): void => {
  accepts<Nested>('required must list every property; missing "inner"')
  accepts<[Clean] extends [never] ? true : false>(true)
}

test("the contract these types are asserted over is a real value", () => {
  expect(ASPECTS.name).toBe("aspects")
  expect(ASPECTS.schema).toMatchObject({ type: "object", additionalProperties: false })
})
