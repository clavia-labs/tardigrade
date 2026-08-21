import { Validator } from "@cfworker/json-schema"
import type { Event } from "@clavia/tardigrade-core/event"

// The turn's output contract: the shape a caller declares for the model's final response, and
// the TypeScript value that shape decodes to. A contract states what the answer is; an
// implementation states how it is obtained (OutputImplementation below). The contract never
// becomes a tool, a tool choice, or a prompt: the provider takes the schema on its own
// response-format surface (platform/model/src/output.ts, outputSchemaFor).

// OUTPUT_NAME_PATTERN is the alphabet a schema identity may use. It is the strictest of the two
// wires this repository binds: the OpenAI-compatible `response_format.json_schema.name` and the
// Converse `outputConfig.textFormat.structure.jsonSchema.name`.
export const OUTPUT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

// OUTPUT_STRING_FORMATS is the `format` allowlist the supported profile admits. A provider that
// strips an unlisted format sends a looser schema than the one declared here, and the declared
// schema is what local validation judges against, so an unlisted format is out of profile
// (output.test.ts, "only the allowlisted string formats survive the wire, so only those are in
// profile").
export const OUTPUT_STRING_FORMATS = [
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid"
] as const

export type OutputStringFormat = (typeof OUTPUT_STRING_FORMATS)[number]

// The supported profile, as a type. A schema outside it is a compile error at `output`, because
// each rule here is a rule a binding cannot honour: an open object or an unlisted property gets
// closed and widened on the way to the provider, a combinator or a reference cannot be sent
// strict at all, and a typeless node is rejected by the wire.
export interface OutputStringSchema {
  readonly type: "string"
  readonly description?: string
  readonly enum?: ReadonlyArray<string>
  readonly format?: OutputStringFormat
}

export interface OutputNumberSchema {
  readonly type: "number" | "integer"
  readonly description?: string
}

export interface OutputBooleanSchema {
  readonly type: "boolean"
  readonly description?: string
}

export interface OutputNullSchema {
  readonly type: "null"
  readonly description?: string
}

export interface OutputArraySchema {
  readonly type: "array"
  readonly items: OutputSchema
  readonly description?: string
}

export interface OutputObjectSchema {
  readonly type: "object"
  readonly properties: { readonly [name: string]: OutputSchema }
  readonly required: ReadonlyArray<string>
  readonly additionalProperties: false
  readonly description?: string
}

// A union is spelled `anyOf`. An optional field is a union with the null member, because a
// property absent from `required` is widened to accept null before it reaches either wire.
export interface OutputUnionSchema {
  readonly anyOf: ReadonlyArray<OutputSchema>
  readonly description?: string
}

export type OutputSchema =
  | OutputStringSchema
  | OutputNumberSchema
  | OutputBooleanSchema
  | OutputNullSchema
  | OutputArraySchema
  | OutputObjectSchema
  | OutputUnionSchema

// Decoded is the TypeScript value a profile schema decodes to. It is the whole of the relation
// between a declared schema and the value a reader gets back (boundary.ts, outputOf).
export type Decoded<S> = S extends { readonly enum: ReadonlyArray<infer E> }
  ? E
  : S extends { readonly type: "string" }
    ? string
    : S extends { readonly type: "number" | "integer" }
      ? number
      : S extends { readonly type: "boolean" }
        ? boolean
        : S extends { readonly type: "null" }
          ? null
          : S extends { readonly type: "array"; readonly items: infer I }
            ? ReadonlyArray<Decoded<I>>
            : S extends { readonly type: "object"; readonly properties: infer P }
              ? { readonly [K in keyof P]: Decoded<P[K]> }
              : S extends { readonly anyOf: ReadonlyArray<infer V> }
                ? Decoded<V>
                : unknown

type Missing<P, R> = Exclude<Extract<keyof P, string>, R>

// OUTPUT_SCHEMA_DEPTH is how deep a schema may nest. The bound is what makes the walk total over
// a value nobody proved is a tree: a model-authored schema arriving through agents.run may point
// at itself, and an unbounded walk of it never returns. outputProfileErrors takes an override, so
// a consumer with deeper schemas states its own number and reads the same reasons.
export const OUTPUT_SCHEMA_DEPTH = 12

// ProfileDepth is the same bound for the type-level rule, which needs a literal. It is the type's
// own reason as well: OutputSchema refers to itself, so an unbounded walk of the constraint
// rather than of a literal never terminates. A schema nested past it still obeys the rule at run
// time, so the bound costs a deep call site its message rather than the rule.
type ProfileDepth = 12

type Shallower = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

// OutputProblems is the one profile rule the type union cannot state structurally: `required`
// must list every property. It is never when the schema is in profile, and the union of reasons
// otherwise (output.types.test.ts).
export type OutputProblems<S, D extends number = ProfileDepth> = [D] extends [never]
  ? never
  : S extends {
        readonly type: "object"
        readonly properties: infer P
        readonly required: ReadonlyArray<infer R>
      }
    ?
        | ([Missing<P, R>] extends [never] ? never : `required must list every property; missing "${Missing<P, R>}"`)
        | OutputProblems<P[keyof P], Shallower[D]>
    : S extends { readonly type: "array"; readonly items: infer I }
      ? OutputProblems<I, Shallower[D]>
      : S extends { readonly anyOf: ReadonlyArray<infer V> }
        ? OutputProblems<V, Shallower[D]>
        : never

// InProfile is the guard `output` intersects into its parameter. An in-profile schema takes
// unknown, which changes nothing; an out-of-profile one takes a member the literal cannot have,
// so the call site reports the rule it broke by name.
export type InProfile<S> = [OutputProblems<S>] extends [never]
  ? unknown
  : { readonly "output schema profile": OutputProblems<S> }

declare const Value: unique symbol

// OutputContract pairs a schema identity with the schema, and carries the decoded value's type.
// The value member is never present at run time; erasing the parameter (OutputContract on its
// own) is the honest type for a schema nobody proved a TypeScript shape for.
export interface OutputContract<T = unknown> {
  readonly name: string
  readonly schema: unknown
  readonly [Value]?: T
}

// output declares a contract. The name is the schema identity both wires carry, and the schema
// must be a profile object schema, checked by the type at the call site and again here for the
// caller who reached this through JavaScript.
export const output = <const S extends OutputObjectSchema>(spec: {
  readonly name: string
  readonly schema: S & InProfile<S>
}): OutputContract<Decoded<S>> => {
  if (!OUTPUT_NAME_PATTERN.test(spec.name)) {
    throw new Error(`output contract name ${JSON.stringify(spec.name)} must match ${String(OUTPUT_NAME_PATTERN)}`)
  }
  const problems = outputProfileErrors(spec.schema)
  if (problems.length > 0) {
    throw new Error(`output contract "${spec.name}" is outside the supported schema profile:\n${problems.map((p) => `- ${p}`).join("\n")}`)
  }
  return { name: spec.name, schema: spec.schema }
}

const KEYWORDS_OUT_OF_PROFILE = ["oneOf", "allOf", "not", "$ref", "$defs", "definitions", "if", "then", "else"]

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const nodeErrors = (node: unknown, at: string, depth: number): ReadonlyArray<string> => {
  if (depth <= 0) return [`${at}: nests deeper than the ${OUTPUT_SCHEMA_DEPTH}-level bound`]
  const schema = record(node)
  if (schema === undefined) return [`${at}: a schema is an object`]
  const problems: Array<string> = []
  for (const keyword of KEYWORDS_OUT_OF_PROFILE) {
    if (keyword in schema) problems.push(`${at}: ${keyword} is outside the profile`)
  }
  if (Array.isArray(schema["anyOf"])) {
    const members = schema["anyOf"]
    if (members.length === 0) problems.push(`${at}: anyOf lists no member`)
    members.forEach((member, index) => problems.push(...nodeErrors(member, `${at}/anyOf/${index}`, depth - 1)))
    return problems
  }
  if (Array.isArray(schema["enum"])) {
    if (schema["enum"].length === 0) problems.push(`${at}: enum lists no value`)
  }
  const type = schema["type"]
  if (typeof type !== "string") {
    problems.push(`${at}: every schema declares one type, or anyOf`)
    return problems
  }
  if (type === "string") {
    const format = schema["format"]
    if (format !== undefined && !(OUTPUT_STRING_FORMATS as ReadonlyArray<string>).includes(String(format))) {
      problems.push(`${at}: format ${JSON.stringify(format)} is outside the profile (${OUTPUT_STRING_FORMATS.join(", ")})`)
    }
    return problems
  }
  if (type === "number" || type === "integer" || type === "boolean" || type === "null") return problems
  if (type === "array") {
    if (schema["items"] === undefined) problems.push(`${at}: an array declares items`)
    else problems.push(...nodeErrors(schema["items"], `${at}/items`, depth - 1))
    return problems
  }
  if (type === "object") {
    const properties = record(schema["properties"])
    if (properties === undefined) {
      problems.push(`${at}: an object declares properties`)
      return problems
    }
    if (schema["additionalProperties"] !== false) problems.push(`${at}: an object declares additionalProperties false`)
    const required = Array.isArray(schema["required"]) ? schema["required"].map(String) : undefined
    if (required === undefined) problems.push(`${at}: an object declares required`)
    else {
      for (const name of Object.keys(properties)) {
        if (!required.includes(name)) problems.push(`${at}: required must list every property; missing "${name}"`)
      }
    }
    for (const [name, member] of Object.entries(properties)) problems.push(...nodeErrors(member, `${at}/${name}`, depth - 1))
    return problems
  }
  problems.push(`${at}: type ${JSON.stringify(type)} is outside the profile`)
  return problems
}

// outputProfileErrors says why a schema is outside the supported profile, one line each, and is
// empty when the schema is one both bound wires send unchanged. It is the preflight for a
// schema no TypeScript signature saw: a model-authored one arriving through agents.run
// (spawn.ts), and the binding's own check before it spends anything (model.ts). `depth` bounds
// the walk, defaulting to OUTPUT_SCHEMA_DEPTH.
export const outputProfileErrors = (schema: unknown, depth: number = OUTPUT_SCHEMA_DEPTH): ReadonlyArray<string> => {
  const root = record(schema)
  if (root === undefined || root["type"] !== "object") return ["/: the declared output is an object schema"]
  return nodeErrors(schema, "", depth)
    .map((problem) => (problem.startsWith(":") ? `/${problem}` : problem))
}

// outputErrors says why a value misses a schema, one line each; empty when it conforms. It is
// the local assertion every implementation shares, including the ones whose provider promised
// a strict guarantee (output.test.ts, "a strict provider is still checked").
export const outputErrors = (schema: unknown, value: unknown): ReadonlyArray<string> => {
  if (schema === undefined || schema === null || typeof schema !== "object") return []
  try {
    const result = new Validator(schema as never).validate(value === undefined ? null : value)
    return result.valid ? [] : result.errors.map((e) => `${e.instanceLocation || "/"}: ${e.error}`)
  } catch (e) {
    // A schema the validator cannot build is a contract error rather than a death: the caller
    // reads which schema, and the turn fails with a reason instead of a stack.
    return [`invalid schema: ${e instanceof Error ? e.message : String(e)}`]
  }
}

// decodeOutput parses a final response and judges it against a contract. `errors` is empty on a
// value that conforms; a response that is not JSON reports that as its one error.
export const decodeOutput = (
  contract: OutputContract,
  text: string
): { readonly value: unknown; readonly errors: ReadonlyArray<string> } => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { value: undefined, errors: [`/: the response is not JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  return { value, errors: outputErrors(contract.schema, value) }
}

// contractOf reads the current turn's declared contract; the last message heads the turn. A
// declaration that is not a contract throws rather than reading as an undeclared turn, which
// would accept any answer at all.
export const contractOf = (trajectory: ReadonlyArray<Event>): OutputContract | undefined => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type !== "MessageReceived") continue
    const declared = (event as { output?: unknown }).output
    if (declared === undefined) return undefined
    const contract = record(declared)
    if (contract === undefined || typeof contract["name"] !== "string" || contract["schema"] === undefined) {
      throw new Error(
        `message ${String((event as { id?: unknown }).id)} declares an output that is not a contract; declare one with output({ name, schema })`
      )
    }
    return { name: contract["name"], schema: contract["schema"] }
  }
  return undefined
}

// OutputImplementation is how a declared contract is obtained, and what a final response that
// misses it means. It is a view fragment a component contributes, so an assembly states its
// choice by what it mounts (runtime/agent.ts, AgentView).
//
// `guarantee` is what the binding is asked for: "native" sends the schema on the provider's own
// response-format surface and requires a strict guarantee there, and "none" sends no schema at
// all. `onMismatch` is what a response that misses the contract is: "fail" ends the turn loudly,
// and "reject" records the response for an implementation that corrects it. `attempts` bounds
// those corrections. `projectHistory` compacts a corrected exchange out of later renders.
export interface OutputImplementation {
  readonly name: string
  readonly guarantee: "native" | "none"
  readonly onMismatch: "fail" | "reject"
  readonly attempts?: number
  readonly projectHistory?: boolean
}

// NATIVE_OUTPUT is the implementation a turn takes when no component mounts another: the
// provider's own strict schema, and a mismatch under that claim is the provider's contract
// violation rather than an occasion to ask again.
export const NATIVE_OUTPUT: OutputImplementation = { name: "native", guarantee: "native", onMismatch: "fail" }

// correctionText is the message an implementation that corrects sends back with a rejected
// response. The reasons are the whole message, plus the encoding trap that produces most of
// them (components/repair.ts).
export const correctionText = (errors: ReadonlyArray<string>): string =>
  `Your reply did not match this turn's output schema:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
  `Reply again with JSON that satisfies the schema, and nothing else. Send values in their declared types: ` +
  `an array is a JSON array, never a string holding one.`
