import { Validator } from "@cfworker/json-schema"
import type { Event } from "@clavia/tardigrade-core/event"

// The turn's output contract: the shape a caller declares for the model's final response, and
// the TypeScript value that shape decodes to. A contract states what the answer is; an
// two values below say how one attempt obtained it (OutputFallback, OutputMode). The contract never
// becomes a tool, a tool choice, or a prompt: the provider takes the schema on its own
// response-format surface (platform/model/src/output.ts, outputSchemaFor).

// OUTPUT_NAME_PATTERN is the alphabet a schema identity may use. It is the strictest of the two
// wires this repository binds: the OpenAI-compatible `response_format.json_schema.name` and the
// Converse `outputConfig.textFormat.structure.jsonSchema.name`.
export const OUTPUT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

// OUTPUT_STRING_FORMATS is the `format` allowlist the supported profile admits. A provider that
// strips an unlisted format sends a looser schema than the one declared here, and the declared
// schema is what local validation judges against, so an unlisted format is out of profile
// (output.test.ts, "only the allowlisted string formats survive the wire").
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
// each rule is a rule a binding cannot honour: an open object or an unlisted property gets
// closed and widened on the way to the provider, a combinator or a reference cannot be sent
// strict at all, a typeless node is rejected by the wire, and a keyword neither wire promises to
// carry would be dropped in flight while local validation still enforced it.
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

// ProfileKeys is the exact keyword set one node may carry. Membership is the whole rule: a
// keyword outside it reaches neither wire intact, so admitting it would let local validation
// enforce something the provider was never told.
type ProfileKeys<S> = S extends { readonly anyOf: unknown }
  ? "anyOf" | "description"
  : S extends { readonly type: "object" }
    ? "type" | "description" | "properties" | "required" | "additionalProperties"
    : S extends { readonly type: "array" }
      ? "type" | "description" | "items"
      : S extends { readonly type: "string" }
        ? "type" | "description" | "enum" | "format"
        : "type" | "description"

type ExtraKeys<S> = Exclude<Extract<keyof S, string>, ProfileKeys<S>>

type Missing<P, R> = Exclude<Extract<keyof P, string>, R>

// A `required` list that widened to string[] carries no names to check, so the rule reads it as
// nothing to say rather than as every name being unlisted. outputProfileErrors still checks it.
type Unlisted<P, R> = string extends R ? never : Exclude<Extract<R, string>, keyof P>

// PROFILE_TYPE_DEPTH bounds the type-level reading alone. OutputSchema refers to itself, so an
// unbounded walk of the constraint rather than of a literal never terminates. outputProfileErrors
// reads every node at any depth and is what decides whether a contract exists, so a schema deeper
// than this loses its compile-time message and keeps the rule
// (output.test.ts, "a schema deeper than the type-level reading is still checked at run time").
type PROFILE_TYPE_DEPTH = 12

type Shallower = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

type NodeProblems<S> =
  | (ExtraKeys<S> extends never ? never : `the keyword "${ExtraKeys<S>}" is outside the profile`)
  | (S extends { readonly type: "object"; readonly properties: infer P; readonly required: ReadonlyArray<infer R> }
      ?
          | (Missing<P, R> extends never ? never : `required must list every property; missing "${Missing<P, R>}"`)
          | (Unlisted<P, R> extends never ? never : `required names "${Unlisted<P, R>}", which is not a property`)
      : never)

type ChildProblems<S, D extends number> = S extends {
  readonly type: "object"
  readonly properties: infer P
}
  ? OutputProblems<P[keyof P], D>
  : S extends { readonly type: "array"; readonly items: infer I }
    ? OutputProblems<I, D>
    : S extends { readonly anyOf: ReadonlyArray<infer V> }
      ? OutputProblems<V, D>
      : never

// OutputProblems is the profile's rules that the type union cannot state structurally: the exact
// keyword set, and `required` naming every property and nothing else. It is never when the
// schema is in profile, and the union of reasons otherwise (output.types.test.ts).
export type OutputProblems<S, D extends number = PROFILE_TYPE_DEPTH> = [D] extends [never]
  ? never
  : // The naked branch distributes, so a union of property schemas is read member by member and
    // an empty `properties` map, whose member type is never, contributes nothing at all.
    S extends unknown
    ? NodeProblems<S> | ChildProblems<S, Shallower[D]>
    : never

// InProfile is the guard `output` intersects into its parameter. An in-profile schema takes
// unknown, which changes nothing; an out-of-profile one takes a member the literal cannot have,
// so the call site reports the rule it broke by name.
export type InProfile<S> = [OutputProblems<S>] extends [never]
  ? unknown
  : { readonly "output schema profile": OutputProblems<S> }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// clone is a deep copy of a schema, which is what keeps a contract independent of the object a
// caller handed it: a caller who kept the reference could otherwise widen the schema after every
// check passed (output.test.ts, "a contract's schema is its own copy, frozen through").
const clone = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clone)
  const node = record(value)
  if (node === undefined) return value
  const copy: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(node)) copy[key] = clone(member)
  return copy
}

const frozen = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    value.forEach(frozen)
    return Object.freeze(value)
  }
  const node = record(value)
  if (node === undefined) return value
  for (const member of Object.values(node)) frozen(member)
  return Object.freeze(node)
}

// validatorFor builds the checker once. The validator writes into the schema it is given
// (@cfworker/json-schema resolves and stamps ids as it walks), so it gets its own mutable copy
// and the contract's public schema stays frozen.
const validatorFor = (schema: unknown): ((value: unknown) => ReadonlyArray<string>) => {
  let built: Validator
  try {
    built = new Validator(clone(schema) as never)
  } catch (e) {
    const reason = `invalid schema: ${e instanceof Error ? e.message : String(e)}`
    return () => [reason]
  }
  return (value: unknown) => {
    try {
      const result = built.validate(value === undefined ? null : value)
      return result.valid ? [] : result.errors.map((e) => `${e.instanceLocation || "/"}: ${e.error}`)
    } catch (e) {
      // A reference the walk cannot resolve surfaces at the first read rather than at
      // construction, and it is the same class of failure: a schema nobody can check.
      return [`invalid schema: ${e instanceof Error ? e.message : String(e)}`]
    }
  }
}

// OutputContract pairs a schema identity with the schema, and carries the decoded value's type.
// It is a class with a private brand rather than a shape, because a shape can be counterfeited:
// an object literal and a spread of a genuine contract both lack the brand, so neither can stand
// where a contract is asked for (output.types.test.ts, cannotBeForged). The
// parameter is covariant, so a proven contract stands where an unproven one is asked for and
// never the reverse. OutputContract on its own, whose value is unknown, is the honest type for a
// schema nobody proved a TypeScript shape for.
export class OutputContract<out T = unknown> {
  // The brand, and the phantom that keeps two contracts with different value types apart. It is
  // read by `decode`, which is the one place a validated value becomes the contract's type.
  readonly #decoded: (nothing: never) => T

  readonly #validate: (value: unknown) => ReadonlyArray<string>

  readonly name: string
  readonly schema: unknown

  private constructor(name: string, schema: unknown) {
    this.#decoded = (nothing: never): T => nothing
    this.name = name
    this.schema = frozen(clone(schema))
    this.#validate = validatorFor(this.schema)
    Object.freeze(this)
  }

  // from is the only constructor. Every rule the profile states runs here, so no path reaches
  // inference with a schema nobody read: a model-authored one (spawn.ts), one read back off the
  // log (declaredOutputOf), and the typed `output` below all arrive through it.
  static from(
    name: unknown,
    schema: unknown
  ): { readonly contract: OutputContract } | { readonly errors: ReadonlyArray<string> } {
    const errors = [...outputNameErrors(name), ...outputProfileErrors(schema)]
    if (errors.length > 0) return { errors }
    return { contract: new OutputContract<unknown>(String(name), schema) }
  }

  // decode reads a value as this contract's type, or says why it cannot. It is the one reader of
  // the phantom, so a value only ever wears a contract's type after that contract validated it.
  decode(value: unknown): { readonly value: T } | { readonly errors: ReadonlyArray<string> } {
    const errors = this.#validate(value)
    return errors.length > 0 ? { errors } : { value: this.#decoded(value as never) }
  }
}

// outputFrom is `OutputContract.from` as a function, for the modules that build a contract from
// values rather than from a literal.
export const outputFrom = (
  name: unknown,
  schema: unknown
): { readonly contract: OutputContract } | { readonly errors: ReadonlyArray<string> } =>
  OutputContract.from(name, schema)

// output declares a contract from a literal. The name is the schema identity both wires carry,
// and the schema must be a profile object schema, checked by the type at the call site and again
// here for the caller who reached this through JavaScript. An out-of-profile schema throws at
// construction, which is startup rather than a turn.
export const output = <const S extends OutputObjectSchema>(spec: {
  readonly name: string
  readonly schema: S & InProfile<S>
}): OutputContract<Decoded<S>> => {
  const built = OutputContract.from(spec.name, spec.schema)
  if ("errors" in built) {
    throw new Error(
      `output contract ${JSON.stringify(spec.name)} is not declarable:\n${built.errors.map((e) => `- ${e}`).join("\n")}`
    )
  }
  return built.contract as OutputContract<Decoded<S>>
}

// outputNameErrors says why a schema identity cannot ride either wire.
export const outputNameErrors = (name: unknown): ReadonlyArray<string> =>
  typeof name === "string" && OUTPUT_NAME_PATTERN.test(name)
    ? []
    : [`the contract name ${JSON.stringify(name)} must match ${String(OUTPUT_NAME_PATTERN)}`]

const KEYS_BY_TYPE: Readonly<Record<string, ReadonlyArray<string>>> = {
  string: ["type", "description", "enum", "format"],
  number: ["type", "description"],
  integer: ["type", "description"],
  boolean: ["type", "description"],
  null: ["type", "description"],
  array: ["type", "description", "items"],
  object: ["type", "description", "properties", "required", "additionalProperties"]
}

const UNION_KEYS: ReadonlyArray<string> = ["anyOf", "description"]

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((member) => typeof member === "string")
    ? (value as ReadonlyArray<string>)
    : undefined

const repeats = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) twice.add(value)
    seen.add(value)
  }
  return [...twice]
}

// A frame is one node owed a reading, or the marker that pops its ancestor. The walk carries its
// own stack so a deep schema cannot exhaust the runtime's, and the ancestor set makes a schema
// that points back at itself a reported reason rather than a hang. Neither is a cap: every node
// of every schema is read (output.test.ts, "a schema that points at itself is refused").
type Frame = { readonly node: unknown; readonly at: string } | { readonly leave: object }

const extraKeys = (node: Record<string, unknown>, allowed: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.keys(node).filter((key) => !allowed.includes(key))

// outputProfileErrors says why a schema is outside the supported profile, one line each, and is
// empty when the schema is one both bound wires send unchanged. Every contract passes it,
// whatever implementation obtains it, so a fail-fast turn, a corrected turn, and a native turn
// all reject the same schemas for the same reasons before anything is spent.
export const outputProfileErrors = (schema: unknown): ReadonlyArray<string> => {
  const root = record(schema)
  if (root === undefined || root["type"] !== "object") return ["/: the declared output is an object schema"]
  const problems: Array<string> = []
  const ancestors = new Set<object>()
  const stack: Array<Frame> = [{ node: schema, at: "" }]
  const say = (at: string, problem: string) => problems.push(`${at === "" ? "/" : at}: ${problem}`)
  while (stack.length > 0) {
    const frame = stack.pop()!
    if ("leave" in frame) {
      ancestors.delete(frame.leave)
      continue
    }
    const { node, at } = frame
    const current = record(node)
    if (current === undefined) {
      say(at, "a schema is an object")
      continue
    }
    if (ancestors.has(current)) {
      say(at, "the schema points back at a node that already declares it; a schema is a tree")
      continue
    }
    ancestors.add(current)
    stack.push({ leave: current })
    const child = (member: unknown, path: string) => stack.push({ node: member, at: path })
    const description = current["description"]
    if (description !== undefined && typeof description !== "string") say(at, "description is a string")
    if (current["anyOf"] !== undefined) {
      for (const key of extraKeys(current, UNION_KEYS)) say(at, `the keyword "${key}" is outside the profile`)
      const members = current["anyOf"]
      if (!Array.isArray(members) || members.length === 0) say(at, "anyOf lists at least one member")
      else members.forEach((member, index) => child(member, `${at}/anyOf/${index}`))
      continue
    }
    const type = current["type"]
    const allowed = typeof type === "string" ? KEYS_BY_TYPE[type] : undefined
    if (allowed === undefined) {
      say(at, `every schema declares one type of ${Object.keys(KEYS_BY_TYPE).join(", ")}, or anyOf`)
      continue
    }
    for (const key of extraKeys(current, allowed)) say(at, `the keyword "${key}" is outside the profile`)
    if (type === "string") {
      const members = current["enum"]
      if (members !== undefined) {
        const values = strings(members)
        if (values === undefined || values.length === 0) say(at, "enum lists at least one string")
        else for (const twice of repeats(values)) say(at, `enum repeats ${JSON.stringify(twice)}`)
      }
      const format = current["format"]
      if (format !== undefined && !(OUTPUT_STRING_FORMATS as ReadonlyArray<string>).includes(String(format))) {
        say(at, `format ${JSON.stringify(format)} is outside the profile (${OUTPUT_STRING_FORMATS.join(", ")})`)
      }
      continue
    }
    if (type === "array") {
      if (current["items"] === undefined) say(at, "an array declares items")
      else child(current["items"], `${at}/items`)
      continue
    }
    if (type !== "object") continue
    const properties = record(current["properties"])
    if (properties === undefined) {
      say(at, "an object declares properties")
      continue
    }
    if (current["additionalProperties"] !== false) say(at, "an object declares additionalProperties false")
    const required = strings(current["required"])
    if (required === undefined) say(at, "required is an array of property names")
    else {
      for (const twice of repeats(required)) say(at, `required repeats ${JSON.stringify(twice)}`)
      for (const name of Object.keys(properties)) {
        if (!required.includes(name)) say(at, `required must list every property; missing ${JSON.stringify(name)}`)
      }
      for (const name of required) {
        if (!(name in properties)) say(at, `required names ${JSON.stringify(name)}, which is not a property`)
      }
    }
    for (const [name, member] of Object.entries(properties)) child(member, `${at}/${name}`)
  }
  return problems
}

// outputErrors says why a value misses a schema, one line each; empty when it conforms. It is the
// local assertion every implementation shares, including the ones whose provider promised a
// strict guarantee. A schema that is not a schema is a failure here rather than a value that
// passes: an unusable schema accepting every answer is the shape of the bug this module exists to
// remove (output.test.ts, "a schema that is not a schema never validates").
export const outputErrors = (schema: unknown, value: unknown): ReadonlyArray<string> => {
  if (record(schema) === undefined) return ["/: the declared output schema is not a schema object"]
  // A schema the validator cannot build is a contract error rather than a death: the caller reads
  // which schema, and the turn fails with a reason instead of a stack (validatorFor).
  return validatorFor(schema)(value)
}

// decodeOutput parses a final response and judges it against a contract. `errors` is empty on a
// value that conforms; a response that is not JSON reports that as its one error.
export const decodeOutput = (
  contract: OutputContract,
  text: string
): { readonly value: unknown; readonly errors: ReadonlyArray<string> } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: undefined, errors: [`/: the response is not JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const decoded = contract.decode(parsed)
  return "errors" in decoded ? { value: parsed, errors: decoded.errors } : { value: decoded.value, errors: [] }
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(",")}}`
}

// canonicalOf is a contract's identity, written the same way whatever order its keys were built
// in. Two contracts are the same contract when their canonical forms match, which is what lets a
// reader prove that the turn it decodes declared the contract it holds (boundary.ts, outputOf).
export const canonicalOf = (contract: OutputContract): string =>
  canonical({ name: contract.name, schema: contract.schema })

// fingerprintOf is that identity as a short stamp, for the attempt and rejection records an
// operator reads. Comparisons use the canonical form itself, so a stamp never decides anything.
export const fingerprintOf = (contract: OutputContract): string => {
  const text = canonicalOf(contract)
  let low = 0x811c9dc5
  let high = 0x01000193
  for (let i = 0; i < text.length; i++) {
    low = Math.imul(low ^ text.charCodeAt(i), 0x01000193) >>> 0
    high = Math.imul(high + text.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`
}

// DeclaredOutput is what a message says about its final response. `invalid` is a declaration that
// is not a contract this repository can serve, and it is a verdict rather than a throw: a
// projection that throws poisons the settle that reads it, so the reactor turns this into a
// terminal before any model is called (runtime/infer.ts, inferReactorFor).
export type DeclaredOutput =
  | { readonly kind: "none" }
  | { readonly kind: "contract"; readonly contract: OutputContract }
  | { readonly kind: "invalid"; readonly errors: ReadonlyArray<string> }

// declarationOf reads one message's `output` field as a contract.
export const declarationOf = (declared: unknown, id: string): DeclaredOutput => {
  if (declared === undefined) return { kind: "none" }
  const carried = record(declared)
  if (carried === undefined || !("name" in carried) || !("schema" in carried)) {
    return {
      kind: "invalid",
      errors: [`message ${id} declares an output that is not a contract; declare one with output({ name, schema })`]
    }
  }
  const built = OutputContract.from(carried["name"], carried["schema"])
  if ("errors" in built) return { kind: "invalid", errors: built.errors.map((problem) => `message ${id}: ${problem}`) }
  return { kind: "contract", contract: built.contract }
}

// declaredOutputOf reads the current turn's declaration; the last message heads the turn.
export const declaredOutputOf = (trajectory: ReadonlyArray<Event>): DeclaredOutput => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type !== "MessageReceived") continue
    return declarationOf((event as { output?: unknown }).output, String((event as { id?: unknown }).id))
  }
  return { kind: "none" }
}

// declarationForTurn reads what one named turn declared, wherever its head sits in the log.
export const declarationForTurn = (log: ReadonlyArray<Event>, turn: string): DeclaredOutput => {
  const head = log.find((event) => event.type === "MessageReceived" && String((event as { id?: unknown }).id) === turn)
  if (head === undefined) return { kind: "none" }
  return declarationOf((head as { output?: unknown }).output, turn)
}

// A declared contract says what the answer is. Two further values say how one attempt got it.
//
// OutputFallback is what a turn does when native structured output is unavailable for the call:
// unavailable because the endpoint promises none, or because it cannot carry a schema beside the
// tools this request offers. It is a view fragment a component contributes, so an assembly states
// its choice by what it mounts (runtime/agent.ts, AgentView), and mounting one never turns native
// output off: native is used whenever it is available (platform/model/src/output.ts, outputModeOf).
//
// `local` takes the answer the model gives and validates it once; a mismatch is a local
// validation failure, chosen deliberately over a retry. `repair` is the framework's correction
// loop: the reactor asks again with the reasons, bounded by `attempts`, and projects the exchange
// out of later renders when `projectHistory` says so. `delegated` records the rejection and stops
// there; the component that mounted it derives what happens next, so its feedback, its bound, and
// its decision to stop are its own (components/repair.ts; docs/output.md).
// Each member forbids the fields the others carry, so a value cannot state a policy nobody
// implements: a native mode with a correction bound, or a fail-fast that projects a history it
// never has (output.types.test.ts, modes).
type NoCorrections = { readonly attempts?: never }
type NoHistory = { readonly projectHistory?: never }

export type OutputFallback =
  | ({ readonly kind: "local"; readonly name: string } & NoCorrections & NoHistory)
  | {
      readonly kind: "repair"
      readonly name: string
      readonly attempts: number
      readonly projectHistory: boolean
    }
  | ({ readonly kind: "delegated"; readonly name: string; readonly projectHistory: boolean } & NoCorrections)

// OutputMode is how one attempt actually obtained the contract: the provider's own strict schema,
// or the fallback the assembly declared. The binding selects it per attempt because only the
// binding knows what the configured endpoint can promise, and every consequence records the one
// that ran, so replay never consults a capability that has since changed
// (events.ts, OutputPolicy).
export type OutputMode = ({ readonly kind: "native"; readonly name: string } & NoCorrections & NoHistory) | OutputFallback

// NATIVE_MODE is the mode an attempt runs in whenever native structured output is available.
export const NATIVE_MODE: OutputMode = { kind: "native", name: "native" }

// correctionsOf is how many corrections the framework loop may spend on one turn epoch. Every
// other mode spends none here: `delegated` bounds itself.
export const correctionsOf = (mode: OutputMode): number => (mode.kind === "repair" ? mode.attempts : 0)

// asksAgain reports whether the infer reactor may schedule another inference after a rejection.
// Only the framework loop says yes; `delegated` parks the turn on its rejection and waits for the
// component that owns it.
export const asksAgain = (mode: OutputMode): boolean => mode.kind === "repair"

// projectsHistory reports whether a corrected exchange stops rendering once the turn completes.
export const projectsHistory = (mode: OutputMode): boolean =>
  (mode.kind === "repair" || mode.kind === "delegated") && mode.projectHistory

// recordsRejection reports whether a missed response becomes an OutputRejected rather than a
// terminal.
export const recordsRejection = (mode: OutputMode): boolean => mode.kind === "repair" || mode.kind === "delegated"

// mismatchCauseOf is the terminal a missed response earns, or undefined when the mode records a
// rejection instead (events.ts, TURN_FAILURE_CAUSES).
export const mismatchCauseOf = (
  mode: OutputMode
): "output_contract_violation" | "output_validation_failed" | undefined =>
  mode.kind === "native"
    ? "output_contract_violation"
    : mode.kind === "local"
      ? "output_validation_failed"
      : undefined

// modeOf reads a mode back off a record, which is how a prior attempt's policy is recovered from
// the log rather than from whatever is mounted or configured now (events.ts, OutputPolicy). An
// unreadable record is undefined, and the caller says what an attempt with no recorded mode means.
export const modeOf = (value: unknown): OutputMode | undefined => {
  const carried = record(value)
  if (carried === undefined) return undefined
  const name = carried["name"]
  const kind = carried["kind"]
  if (typeof name !== "string") return undefined
  if (kind === "native") return { kind: "native", name }
  if (kind === "local") return { kind: "local", name }
  const projectHistory = carried["projectHistory"] === true
  if (kind === "delegated") return { kind: "delegated", name, projectHistory }
  if (kind !== "repair") return undefined
  const attempts = carried["attempts"]
  if (correctionAttemptsErrors(attempts).length > 0) return undefined
  return { kind: "repair", name, attempts: attempts as number, projectHistory }
}

// fallbackOf reads a declared fallback back off a record. A native mode is no fallback, so it
// reads as none.
export const fallbackOf = (value: unknown): OutputFallback | undefined => {
  const mode = modeOf(value)
  return mode === undefined || mode.kind === "native" ? undefined : mode
}

// correctionAttemptsErrors says why a correction bound cannot be applied. A bound that is not a
// whole count of asks is rejected where it is stated rather than silently floored at a turn
// (components/repair.ts, repairPolicyOf).
export const correctionAttemptsErrors = (attempts: unknown): ReadonlyArray<string> =>
  typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0
    ? []
    : [`corrections must be a whole count of asks, zero or more, and ${JSON.stringify(attempts)} is not`]

// correctionText is the framework repair loop's own feedback, and nothing else uses it: a
// delegated implementation writes its own, so the core never speaks for a component
// (components/repair.ts; request.ts, renderMessages).
export const correctionText = (errors: ReadonlyArray<string>): string =>
  `Your reply did not match this turn's output schema:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
  `Reply again with JSON that satisfies the schema, and nothing else. Send values in their declared types: ` +
  `an array is a JSON array, never a string holding one.`

// projectedOutput is the one history projection, applied before rendering, before the context
// measure, and before the summary brief, so no reader sees an exchange another reader hid. A
// rejection whose turn went on to complete, and whose own recorded policy projects history, stops
// being rendered, counted, and summarized; the rejection stays in the log. The policy read is the
// one recorded on the rejection, so a deployment that mounts a different policy later cannot
// rewrite what an old turn means (request.ts, renderMessages; components/compaction.ts).
export const projectedOutput = (events: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  if (!events.some((event) => event.type === "OutputRejected")) return events
  const completed = new Set(
    events.filter((e) => e.type === "TurnCompleted").map((e) => String((e as { turn?: unknown }).turn))
  )
  return events.filter((event) => {
    if (event.type !== "OutputRejected") return true
    if (!completed.has(String((event as { turn?: unknown }).turn))) return true
    // A rejection recorded with no mode predates the stamp. Keeping it renders the evidence,
    // which is the safe side of the two.
    const mode = modeOf((event as { mode?: unknown }).mode)
    return mode === undefined || !projectsHistory(mode)
  })
}
