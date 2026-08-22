import { Validator } from "@cfworker/json-schema"
import type { Event } from "@clavia/tardigrade-core/event"

// OutputContract defines the schema and decoded TypeScript value for a turn's result. Native mode sends the schema through the provider's response-format surface (platform/model/src/output.ts, outputSchemaFor).

// OUTPUT_NAME_PATTERN accepts names supported by the OpenAI-compatible and Converse output fields.
export const OUTPUT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

// OUTPUT_STRING_FORMATS lists the string formats accepted by the shared schema profile (output.test.ts, "only the allowlisted string formats survive the wire").
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

// OutputStringSchema is a string node in the shared schema profile.
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

// OutputUnionSchema represents a union with `anyOf`. Nullable fields include a null member and remain required properties.
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

// Decoded maps a profile schema to the value returned by outputOf (boundary.ts, outputOf).
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

// ProfileKeys lists the accepted keywords for each schema node.
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

// Unlisted defers a widened string array to outputProfileErrors because its members are unknown at compile time.
type Unlisted<P, R> = string extends R ? never : Exclude<Extract<R, string>, keyof P>

type NodeProblems<S> =
  | (ExtraKeys<S> extends never ? never : `the keyword "${ExtraKeys<S>}" is outside the profile`)
  | (S extends { readonly type: "object"; readonly properties: infer P; readonly required: ReadonlyArray<infer R> }
      ?
          | (Missing<P, R> extends never ? never : `required must list every property; missing "${Missing<P, R>}"`)
          | (Unlisted<P, R> extends never ? never : `required names "${Unlisted<P, R>}", which is not a property`)
      : never)

type ChildProblems<S> = S extends {
  readonly type: "object"
  readonly properties: infer P
}
  ? OutputProblems<P[keyof P]>
  : S extends { readonly type: "array"; readonly items: infer I }
    ? OutputProblems<I>
    : S extends { readonly anyOf: ReadonlyArray<infer V> }
      ? OutputProblems<V>
      : never

// OutputProblems reports profile rules that the structural schema union cannot express (output.types.test.ts).
export type OutputProblems<S> =
  // The naked branch distributes across union members and treats an empty properties map as valid.
  S extends unknown ? NodeProblems<S> | ChildProblems<S> : never

// InProfile adds named type errors to output calls with an invalid literal schema.
export type InProfile<S> = [OutputProblems<S>] extends [never]
  ? unknown
  : { readonly "output schema profile": OutputProblems<S> }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// clone copies a schema so later mutations to the source cannot change a contract (output.test.ts, "a contract's schema is its own copy, frozen through").
const clone = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clone)
  const node = record(value)
  if (node === undefined) return value
  // Object.fromEntries preserves `__proto__` as a JSON property (output.test.ts, "a schema snapshot preserves every JSON property name").
  return Object.fromEntries(Object.entries(node).map(([key, member]) => [key, clone(member)]))
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

// validatorFor builds a reusable validator from a mutable private schema copy.
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
      // Validator failures remain contract errors at the read boundary.
      return [`invalid schema: ${e instanceof Error ? e.message : String(e)}`]
    }
  }
}

// OutputContract pairs a schema identity with a frozen schema and its decoded value type. Its private brand prevents object literals and spreads from satisfying the contract type (output.types.test.ts, cannotBeForged).
export class OutputContract<out T = unknown> {
  // #decoded carries the covariant value type and is called only after validation.
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

  // from validates every contract source before construction.
  static from(
    name: unknown,
    schema: unknown
  ): { readonly contract: OutputContract } | { readonly errors: ReadonlyArray<string> } {
    const errors = [...outputNameErrors(name), ...outputProfileErrors(schema)]
    if (errors.length > 0) return { errors }
    return { contract: new OutputContract<unknown>(String(name), schema) }
  }

  // decode returns the typed value only after this contract validates it.
  decode(value: unknown): { readonly value: T } | { readonly errors: ReadonlyArray<string> } {
    const errors = this.#validate(value)
    return errors.length > 0 ? { errors } : { value: this.#decoded(value as never) }
  }
}

// outputFrom constructs an unknown-valued contract from run-time data.
export const outputFrom = (
  name: unknown,
  schema: unknown
): { readonly contract: OutputContract } | { readonly errors: ReadonlyArray<string> } =>
  OutputContract.from(name, schema)

// output constructs a typed contract from a literal and validates it again for JavaScript callers.
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

// Frame lets outputProfileErrors traverse without recursion and detect cycles (output.test.ts, "a schema that points at itself is refused").
type Frame = { readonly node: unknown; readonly at: string } | { readonly leave: object }

const extraKeys = (node: Record<string, unknown>, allowed: ReadonlyArray<string>): ReadonlyArray<string> =>
  Object.keys(node).filter((key) => !allowed.includes(key))

// outputProfileErrors reports each violation of the shared schema profile.
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
        if (!Object.hasOwn(properties, name)) say(at, `required names ${JSON.stringify(name)}, which is not a property`)
      }
    }
    for (const [name, member] of Object.entries(properties)) child(member, `${at}/${name}`)
  }
  return problems
}

// outputErrors reports each local validation failure, including an invalid schema (output.test.ts, "a schema that is not a schema never validates").
export const outputErrors = (schema: unknown, value: unknown): ReadonlyArray<string> => {
  if (record(schema) === undefined) return ["/: the declared output schema is not a schema object"]
  // validatorFor converts validator construction failures into contract errors.
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

// DeclaredOutput is the validated output declaration on a message. Invalid declarations become preflight terminals (runtime/infer.ts, inferReactorFor).
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

// OutputFallback defines behavior when native structured output is unavailable for a call. Mounting a fallback leaves native mode preferred (platform/model/src/output.ts, outputModeOf).
type NoCorrections = { readonly attempts?: never }
type NoHistory = { readonly projectHistory?: never }

export type OutputFallback =
  | ({ readonly kind: "local"; readonly name: "fail-fast" } & NoCorrections & NoHistory)
  | {
      readonly kind: "repair"
      readonly name: "repair"
      readonly attempts: number
      readonly projectHistory: boolean
    }
  | ({ readonly kind: "delegated"; readonly name: string; readonly projectHistory: boolean } & NoCorrections)

// OutputMode records how an attempt obtained its declared result (events.ts, OutputPolicy).
export type OutputMode = ({ readonly kind: "native"; readonly name: "native" } & NoCorrections & NoHistory) | OutputFallback

// NATIVE_MODE is the mode an attempt runs in whenever native structured output is available.
export const NATIVE_MODE: OutputMode = { kind: "native", name: "native" }

// correctionsOf returns the framework-managed correction limit for one turn epoch.
export const correctionsOf = (mode: OutputMode): number => (mode.kind === "repair" ? mode.attempts : 0)

// asksAgain reports whether the infer reactor schedules another attempt after a rejection.
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

// modeOf validates a recorded mode so replay uses the policy stored with the attempt (events.ts, OutputPolicy).
export const modeOf = (value: unknown): OutputMode | undefined => {
  const carried = record(value)
  if (carried === undefined) return undefined
  const name = carried["name"]
  const kind = carried["kind"]
  const hasOnly = (allowed: ReadonlyArray<string>) => Object.keys(carried).every((key) => allowed.includes(key))
  if (kind === "native") {
    return name === "native" && hasOnly(["kind", "name"]) ? { kind: "native", name } : undefined
  }
  if (kind === "local") {
    return name === "fail-fast" && hasOnly(["kind", "name"]) ? { kind: "local", name } : undefined
  }
  const projectHistory = carried["projectHistory"]
  if (kind === "delegated") {
    return typeof name === "string" && OUTPUT_NAME_PATTERN.test(name) && typeof projectHistory === "boolean" &&
        hasOnly(["kind", "name", "projectHistory"])
      ? { kind: "delegated", name, projectHistory }
      : undefined
  }
  if (kind !== "repair") return undefined
  const attempts = carried["attempts"]
  if (
    name !== "repair" ||
    typeof projectHistory !== "boolean" ||
    !hasOnly(["kind", "name", "attempts", "projectHistory"]) ||
    correctionAttemptsErrors(attempts).length > 0
  ) return undefined
  return { kind: "repair", name, attempts: attempts as number, projectHistory }
}

// fallbackOf validates a recorded fallback and excludes native mode.
export const fallbackOf = (value: unknown): OutputFallback | undefined => {
  const mode = modeOf(value)
  return mode === undefined || mode.kind === "native" ? undefined : mode
}

// correctionAttemptsErrors reports invalid correction bounds (components/repair.ts, repairPolicyOf).
export const correctionAttemptsErrors = (attempts: unknown): ReadonlyArray<string> =>
  typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0
    ? []
    : [`corrections must be a whole count of asks, zero or more, and ${JSON.stringify(attempts)} is not`]

// correctionText formats validation errors for the framework repair loop.
export const correctionText = (errors: ReadonlyArray<string>): string =>
  `Your reply did not match this turn's output schema:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
  `Reply again with JSON that satisfies the schema, and nothing else. Send values in their declared types: ` +
  `an array is a JSON array, never a string holding one.`

// projectedOutput removes completed correction exchanges from model input, context measurement, and summaries when their recorded policy requests projection (request.ts, renderMessages; components/compaction.ts).
export const projectedOutput = (events: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  if (!events.some((event) => event.type === "OutputRejected")) return events
  const completed = new Set(
    events.filter((e) => e.type === "TurnCompleted").map((e) => String((e as { turn?: unknown }).turn))
  )
  const hidden = new Set<string>()
  for (const event of events) {
    if (event.type !== "OutputRejected" || !completed.has(String((event as { turn?: unknown }).turn))) continue
    const mode = modeOf((event as { mode?: unknown }).mode)
    const attempt = (event as { attempt?: unknown }).attempt
    if (mode !== undefined && projectsHistory(mode) && typeof attempt === "string") hidden.add(attempt)
  }
  return events.filter((event) => {
    if (event.type === "OutputRejected") return !hidden.has(String((event as { attempt?: unknown }).attempt))
    if (event.type === "OutputRetryRequested") {
      return !hidden.has(String((event as { rejection?: unknown }).rejection))
    }
    return true
  })
}
