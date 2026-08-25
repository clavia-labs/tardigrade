import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import {
  canonicalOf,
  correctionAttemptsErrors,
  correctionText,
  decodeOutput,
  declaredOutputOf,
  fingerprintOf,
  modeOf,
  output,
  outputErrors,
  outputFrom,
  outputProfileErrors,
  projectedOutput,
  OUTPUT_STRING_FORMATS
} from "./contract"

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

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)): unknown => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
})

describe("the supported profile", () => {
  test("a profile schema passes, and the contract carries its identity", () => {
    expect(outputProfileErrors(SCOUT.schema)).toEqual([])
    expect(SCOUT.name).toBe("scout")
  })

  // Each rule below is part of the shared strict subset. OpenAI requires every property and both
  // providers require closed objects, so an optional property has to be explicit as a null union.
  test("an unlisted property is out of profile", () => {
    const problems = outputProfileErrors(objectSchema({ a: { type: "string" }, b: { type: "string" } }, ["a"]))
    expect(problems.join(" ")).toContain('required must list every property; missing "b"')
  })

  test("a required name that is not a property is out of profile", () => {
    const problems = outputProfileErrors(objectSchema({ a: { type: "string" } }, ["a", "ghost"]))
    expect(problems.join(" ")).toContain('required names "ghost", which is not a property')
    expect(outputProfileErrors(objectSchema({}, ["toString"])).join(" ")).toContain(
      'required names "toString", which is not a property'
    )
  })

  test("a repeated required name is out of profile", () => {
    expect(outputProfileErrors(objectSchema({ a: { type: "string" } }, ["a", "a"])).join(" ")).toContain(
      'required repeats "a"'
    )
  })

  test("an open object is out of profile", () => {
    expect(
      outputProfileErrors({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }).join(" ")
    ).toContain("additionalProperties false")
  })

  // The profile is closed, so a keyword neither wire promises to carry is a reason rather than a
  // silent pass. Local validation would otherwise enforce a constraint the model never received.
  test("every keyword outside the profile is named, at any depth", () => {
    for (const keyword of ["pattern", "minLength", "minimum", "title", "default", "$schema", "examples", "$ref", "oneOf"]) {
      const problems = outputProfileErrors(objectSchema({ a: { type: "string", [keyword]: 1 } }))
      expect(problems.join(" ")).toContain(`the keyword "${keyword}" is outside the profile`)
    }
    const nested = outputProfileErrors(
      objectSchema({ a: { type: "array", items: objectSchema({ b: { type: "string", pattern: "^x$" } }) } })
    )
    expect(nested.join(" ")).toContain('/a/items/b: the keyword "pattern" is outside the profile')
  })

  test("a typeless node is out of profile: strict mode rejects the request", () => {
    expect(outputProfileErrors(objectSchema({ a: {} })).join(" ")).toContain("every schema declares one type")
  })

  test("an enum states at least one string, and repeats nothing", () => {
    expect(outputProfileErrors(objectSchema({ a: { type: "string", enum: ["x", "y"] } }))).toEqual([])
    expect(outputProfileErrors(objectSchema({ a: { type: "string", enum: [] } })).join(" ")).toContain(
      "enum lists at least one string"
    )
    expect(outputProfileErrors(objectSchema({ a: { type: "string", enum: [1] } })).join(" ")).toContain(
      "enum lists at least one string"
    )
    expect(outputProfileErrors(objectSchema({ a: { type: "string", enum: ["x", "x"] } })).join(" ")).toContain(
      'enum repeats "x"'
    )
  })

  test("anyOf lists members, and carries no other keyword", () => {
    expect(outputProfileErrors(objectSchema({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }))).toEqual([])
    expect(outputProfileErrors(objectSchema({ a: { anyOf: [] } })).join(" ")).toContain("anyOf lists at least one member")
    expect(outputProfileErrors(objectSchema({ a: { anyOf: [{ type: "string" }], type: "string" } })).join(" ")).toContain(
      'the keyword "type" is outside the profile'
    )
  })

  test("only the allowlisted string formats survive the wire", () => {
    for (const format of OUTPUT_STRING_FORMATS) {
      expect(outputProfileErrors(objectSchema({ a: { type: "string", format } }))).toEqual([])
    }
    expect(outputProfileErrors(objectSchema({ a: { type: "string", format: "uri" } })).join(" ")).toContain(
      'format "uri" is outside the profile'
    )
  })

  test("a schema that points at itself is refused rather than walked forever", () => {
    // A model-authored schema is a value nobody proved is a tree (spawn.ts, outputAsked).
    const cyclic: Record<string, unknown> = { type: "object", required: ["self"], additionalProperties: false }
    cyclic["properties"] = { self: cyclic }
    expect(outputProfileErrors(cyclic).join(" ")).toContain("points back at a node that already declares it")
  })

  test("a deep dynamic schema is checked through to its leaf", () => {
    let deep: unknown = objectSchema({ leaf: { type: "string", pattern: "^x$" } })
    for (let i = 0; i < 15; i++) deep = objectSchema({ down: deep })
    expect(outputProfileErrors(deep).join(" ")).toContain('the keyword "pattern" is outside the profile')
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
    ).toThrow("is not declarable")
    expect(() =>
      output({ name: "not a name", schema: { type: "object", properties: {}, required: [], additionalProperties: false } })
    ).toThrow("must match")
  })
})

describe("a contract is a value nobody else can make", () => {
  test("a contract's schema is its own copy, frozen through", () => {
    const schema = {
      type: "object" as const,
      properties: { a: { type: "string" as const } },
      required: ["a"],
      additionalProperties: false as const
    }
    const contract = output({ name: "snapshot", schema })
    // Editing the caller's object after construction changes nothing here.
    ;(schema.properties as Record<string, unknown>)["b"] = { type: "string" }
    expect(Object.keys((contract.schema as { properties: object }).properties)).toEqual(["a"])
    // And the contract's own copy refuses an edit rather than taking one.
    expect(() => {
      ;(contract.schema as { type: string }).type = "null"
    }).toThrow()
    expect(() => {
      ;(contract as { name: string }).name = "other"
    }).toThrow()
  })

  test("a schema snapshot preserves every JSON property name", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}'
    )
    const built = outputFrom("prototype_key", schema)
    expect("contract" in built).toBe(true)
    if (!("contract" in built)) return
    const properties = (built.contract.schema as { properties: Record<string, unknown> }).properties
    expect(Object.hasOwn(properties, "__proto__")).toBe(true)
    expect(decodeOutput(built.contract, '{"__proto__":"kept"}').errors).toEqual([])
  })

  test("outputFrom is the honest constructor for a schema no signature saw", () => {
    const built = outputFrom("inline", objectSchema({ a: { type: "string" } }))
    expect("contract" in built && built.contract.name).toBe("inline")
    const refused = outputFrom("inline", { type: "null" })
    expect("errors" in refused && refused.errors.length).toBeGreaterThan(0)
    expect("errors" in outputFrom("not a name", objectSchema({}))).toBe(true)
  })

  test("identity is the canonical form, so key order and a reused name never decide it", () => {
    const one = outputFrom("scout", { type: "object", properties: {}, required: [], additionalProperties: false })
    const other = outputFrom("scout", { additionalProperties: false, required: [], properties: {}, type: "object" })
    expect("contract" in one && "contract" in other && canonicalOf(one.contract) === canonicalOf(other.contract)).toBe(true)
    const sameName = outputFrom("scout", objectSchema({ a: { type: "string" } }))
    expect("contract" in one && "contract" in sameName && canonicalOf(one.contract) === canonicalOf(sameName.contract)).toBe(
      false
    )
    expect(fingerprintOf(SCOUT)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("validation", () => {
  test("a conforming value has no errors, and a strict provider is still checked", () => {
    expect(outputErrors(SCOUT.schema, { aspects: [{ name: "a", description: "b" }] })).toEqual([])
  })

  test("a schema that is not a schema never validates", () => {
    // A contract can never hold one, and an exported checker that quietly passed everything would
    // be the same bug in a different place.
    for (const schema of [null, undefined, "object", 7]) {
      expect(outputErrors(schema, { anything: true })).toEqual(["/: the declared output schema is not a schema object"])
    }
  })

  test("the double-encoded result is caught, and the reason names the field", () => {
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

  test("the framework correction message carries every reason and names the encoding trap", () => {
    const text = correctionText(["/aspects: expected array", "/name: expected string"])
    expect(text).toContain("/aspects: expected array")
    expect(text).toContain("never a string holding one")
  })

  test("a correction bound is a whole count of asks, or it is refused", () => {
    expect(correctionAttemptsErrors(0)).toEqual([])
    expect(correctionAttemptsErrors(3)).toEqual([])
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2", undefined]) {
      expect(correctionAttemptsErrors(bad).length).toBe(1)
    }
  })
})

describe("the declaration on the log", () => {
  const declaration = { name: SCOUT.name, schema: SCOUT.schema }

  test("the turn's head declares the contract; an undeclared turn has none", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m0", text: "older", at: 1 },
      { type: "MessageReceived", id: "m1", text: "go", output: declaration, at: 2 }
    ]
    const read = declaredOutputOf(log)
    expect(read.kind === "contract" && canonicalOf(read.contract)).toBe(canonicalOf(SCOUT))
    expect(declaredOutputOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]).kind).toBe("none")
    expect(declaredOutputOf([]).kind).toBe("none")
  })

  // A projection that throws poisons the settle that reads it, so a declaration nobody can serve
  // is a verdict the reactor turns into a terminal (inference/reactor.ts).
  test("a declaration that is not a contract is a verdict, never a throw", () => {
    const bad = declaredOutputOf([{ type: "MessageReceived", id: "m1", text: "go", output: { type: "object" }, at: 1 }])
    expect(bad.kind).toBe("invalid")
    expect(bad.kind === "invalid" && bad.errors.join(" ")).toContain("is not a contract")
    const loose = declaredOutputOf([
      { type: "MessageReceived", id: "m1", text: "go", output: { name: "x", schema: { type: "null" } }, at: 1 }
    ])
    expect(loose.kind).toBe("invalid")
    expect(loose.kind === "invalid" && loose.errors.join(" ")).toContain("object schema")
  })
})

describe("the history projection", () => {
  const rejection = (turn: string, projectHistory: boolean): Event => ({
    type: "OutputRejected",
    contract: "scout",
    attempt: `${turn}/infer/0`,
    text: "{}",
    errors: ["/: bad"],
    mode: { kind: "repair", name: "repair", attempts: 2, projectHistory },
    turn,
    at: 1
  })

  test("a rejection is projected away only once its own turn completed", () => {
    const open: ReadonlyArray<Event> = [rejection("m1", true)]
    expect(projectedOutput(open)).toHaveLength(1)
    const done: ReadonlyArray<Event> = [rejection("m1", true), { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }]
    expect(projectedOutput(done).map((e) => e.type)).toEqual(["TurnCompleted"])
  })

  test("the policy read is the recorded one, so a later mount cannot rewrite an old turn", () => {
    const kept: ReadonlyArray<Event> = [
      rejection("m1", false),
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }
    ]
    expect(projectedOutput(kept)).toHaveLength(2)
  })

  test("a rejection with no recorded mode keeps rendering: evidence is the safe side", () => {
    const bare: ReadonlyArray<Event> = [
      { type: "OutputRejected", contract: "scout", attempt: "m1/infer/0", text: "{}", errors: [], turn: "m1", at: 1 },
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }
    ]
    expect(projectedOutput(bare)).toHaveLength(2)
  })

  test("a mode reads back off a record, and an unreadable one is undefined", () => {
    expect(modeOf({ kind: "repair", name: "repair", attempts: 2, projectHistory: true })).toEqual({
      kind: "repair",
      name: "repair",
      attempts: 2,
      projectHistory: true
    })
    expect(modeOf({ kind: "native", name: "native" })).toEqual({ kind: "native", name: "native" })
    expect(modeOf({ kind: "local", name: "validate-once" })).toEqual({ kind: "local", name: "validate-once" })
    expect(modeOf({ kind: "local", name: "fail-fast" })).toEqual({ kind: "local", name: "validate-once" })
    expect(modeOf({ kind: "repair", name: "repair", attempts: -1 })).toBeUndefined()
    expect(modeOf({ kind: "repair", name: "repair", attempts: 2, projectHistory: "yes" })).toBeUndefined()
    expect(modeOf({ kind: "repair", name: "retry", attempts: 2, projectHistory: true })).toBeUndefined()
    expect(modeOf({ kind: "native", name: "native", attempts: 2 })).toBeUndefined()
    expect(modeOf({ kind: "delegated", name: "", projectHistory: true })).toBeUndefined()
    expect(modeOf({ kind: "invented", name: "x" })).toBeUndefined()
    expect(modeOf(null)).toBeUndefined()
  })

  test("a projected delegated correction removes its decision with its rejection", () => {
    const log: ReadonlyArray<Event> = [
      {
        type: "OutputRejected",
        contract: "scout",
        attempt: "m1/infer/0",
        text: "{}",
        errors: ["/: bad"],
        mode: { kind: "delegated", name: "house-style", projectHistory: true },
        turn: "m1",
        at: 1
      },
      {
        type: "OutputRetryRequested",
        rejection: "m1/infer/0",
        feedback: "try again",
        by: "output.house-style",
        turn: "m1",
        at: 2
      },
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 3 }
    ]
    expect(projectedOutput(log).map((event) => event.type)).toEqual(["TurnCompleted"])
  })
})
