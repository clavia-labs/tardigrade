import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect"

// The boundary between a declared schema and the JSON a model reads.
//
// A schema is declared once, as a `Schema`. Two things need it in different forms. A provider reads
// JSON Schema, so a declaration is lowered into JSON when it goes out. A check reads the schema back
// from the log, because a turn declares its output in its own message and a decide must reach that
// declaration on every settle and every replay. A `Schema` is a runtime value and can not sit in an
// event, so what the log carries is the lowered JSON, and the check lifts it back.
//
// The round trip is why both directions live here. Lowering and lifting are pure, so a decide can
// call the check, and a replay of the same log reaches the same verdict.

// What a provider reads. Object schemas close to additional properties, so a model that invents a
// field is told rather than silently believed.
export const jsonSchemaOf = (schema: Schema.Constraint): Record<string, unknown> =>
  Schema.toJsonSchemaDocument(schema).schema as Record<string, unknown>

// Lifting can fail on a schema this JSON Schema dialect can not express. A declaration that does not
// survive the round trip checks nothing, which is the same answer as a turn that declared nothing.
//
// The lifted schema is narrowed to one that decodes without services. A JSON Schema document
// describes data and names no service, so the import can not have produced a schema that needs one.
const lifted = (schema: unknown): Schema.ConstraintDecoder<unknown, never> | undefined => {
  if (schema === null || typeof schema !== "object") return undefined
  try {
    return SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12(schema as JsonSchema.JsonSchema),
      // A pattern is a constraint this check does not enforce rather than a reason to refuse the
      // whole schema, and refusing inside a decide would be a defect rather than a repairable answer.
      { patterns: "ignore" }
    ) as unknown as Schema.ConstraintDecoder<unknown, never>
  } catch {
    return undefined
  }
}

// Why a value misses the schema the log carries, or undefined when it conforms. Every failure is
// reported at once, because a model repairing one field at a time spends a turn per field.
export const schemaErrors = (schema: unknown, value: unknown): string | undefined => {
  const target = lifted(schema)
  if (target === undefined) return undefined
  const decoded = Schema.decodeUnknownResult(target, {
    errors: "all",
    onExcessProperty: "error"
  })(value === undefined ? {} : value)
  return Result.isFailure(decoded) ? decoded.failure.message : undefined
}

// What the model reads when its answer misses the schema. The reasons are the whole message, so the
// model repairs the shape it actually got wrong.
export const repairText = (reason: string): string =>
  `Your answer did not match this turn's output schema:\n${reason}\n` +
  "Call the answer tool again with arguments that satisfy the schema. Send values in their " +
  "declared types: an array is a JSON array, never a string holding one."
