import { expect, test } from "bun:test"
import { output, type Decoded, type OutputContract, type OutputFallback, type OutputMode, type OutputProblems } from "./contract"

// The compile-time half of the contract. Every assertion here is checked by `bun run typecheck`,
// which fails on an unsatisfied `@ts-expect-error` as loudly as on a type error, so a schema that
// stops being rejected and a value that stops being inferred both break the gate. The runtime
// half is output.test.ts.
//
// The assertions sit inside functions nobody calls: a rejected `output` call throws at
// construction, and the values are parameters rather than built.

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

// A contract is nominal, so no shape stands in for one. Both probes below are the ways a shape
// would have been counterfeited: a fresh literal, and a spread of a genuine contract with the
// public fields replaced (output.test.ts, "a contract's schema is its own copy, frozen through").
export const cannotBeForged = (genuine: typeof ASPECTS): void => {
  // @ts-expect-error a literal is not a contract, whatever fields it copies
  accepts<OutputContract<Aspects>>({ name: "forged", schema: { type: "null" } })
  // @ts-expect-error a spread of a contract loses the brand that made it one
  accepts<OutputContract<Aspects>>({ ...genuine, name: "forged", schema: { type: "null" } })
  // @ts-expect-error the same holds for the erased contract type
  accepts<OutputContract>({ name: "forged", schema: { type: "null" } })
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
    name: "ghost",
    // @ts-expect-error required names a property the schema does not declare
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"], additionalProperties: false }
  })
  output({
    name: "open",
    // @ts-expect-error an object declares additionalProperties false, or the wire closes it
    schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
  })
  output({
    name: "patterned",
    // @ts-expect-error a keyword neither wire carries is outside the profile
    schema: {
      type: "object",
      properties: { a: { type: "string", pattern: "^x$" } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "titled",
    // @ts-expect-error the same holds for an annotation keyword
    schema: {
      type: "object",
      properties: { a: { type: "string", title: "A" } },
      required: ["a"],
      additionalProperties: false
    }
  })
  output({
    name: "nested",
    // @ts-expect-error the rule reads every node, not only the root's own properties
    schema: {
      type: "object",
      properties: {
        a: {
          type: "array",
          items: { type: "object", properties: { b: { type: "string", minLength: 1 } }, required: ["b"], additionalProperties: false }
        }
      },
      required: ["a"],
      additionalProperties: false
    }
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

// A mode is a closed union, so a value cannot state a policy nobody implements. Each probe below
// is a policy that reads as sensible and is not one.
export const modes = (): void => {
  accepts<OutputMode>({ kind: "native", name: "native" })
  accepts<OutputMode>({ kind: "local", name: "validate-once" })
  accepts<OutputMode>({ kind: "repair", name: "repair", attempts: 2, projectHistory: true })
  accepts<OutputMode>({ kind: "delegated", name: "mine", projectHistory: false })
  // @ts-expect-error the native implementation has one durable identity
  accepts<OutputMode>({ kind: "native", name: "provider-native" })
  // @ts-expect-error the local implementation is the exported validate-once behavior
  accepts<OutputMode>({ kind: "local", name: "local" })
  // @ts-expect-error the framework repair behavior has one durable identity
  accepts<OutputMode>({ kind: "repair", name: "retry", attempts: 2, projectHistory: true })
  // @ts-expect-error a native mode has no correction bound to state
  accepts<OutputMode>({ kind: "native", name: "native", attempts: 100, projectHistory: true })
  // @ts-expect-error a local mode has no history to project: it never corrects
  accepts<OutputMode>({ kind: "local", name: "validate-once", projectHistory: true })
  // @ts-expect-error the framework loop states its bound
  accepts<OutputMode>({ kind: "repair", name: "repair", projectHistory: true })
  // @ts-expect-error a delegated mode owns its own bound, so it states none here
  accepts<OutputMode>({ kind: "delegated", name: "mine", projectHistory: false, attempts: 3 })
  // @ts-expect-error the kinds are the four the framework implements
  accepts<OutputMode>({ kind: "native-checked", name: "invented" })
  // A fallback is what a component mounts, and native is never one of them: mounting a policy
  // cannot turn the provider's own guarantee off (components/repair.ts).
  accepts<OutputFallback>({ kind: "repair", name: "repair", attempts: 1, projectHistory: false })
  // @ts-expect-error native is a mode an attempt runs in, never a fallback a component declares
  accepts<OutputFallback>({ kind: "native", name: "native" })
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

type Wrap<S> = {
  readonly type: "object"
  readonly properties: { readonly down: S }
  readonly required: readonly ["down"]
  readonly additionalProperties: false
}

type SixteenDeep = Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<Wrap<{
  readonly type: "string"
  readonly pattern: "^x$"
}>>>>>>>>>>>>>>>>

type DeepProblem = OutputProblems<SixteenDeep>

export const reports = (): void => {
  accepts<Nested>('required must list every property; missing "inner"')
  accepts<[Clean] extends [never] ? true : false>(true)
  accepts<DeepProblem>('the keyword "pattern" is outside the profile')
}

test("the contract these types are asserted over is a real value", () => {
  expect(ASPECTS.name).toBe("aspects")
  expect(ASPECTS.schema).toMatchObject({ type: "object", additionalProperties: false })
})
