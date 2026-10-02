import { JsonPointer, JsonSchema, Schema } from "effect"

// jsonSchemaOf exports a self-contained Draft-07 schema with an inline root (packages/platform/test/bun/rpc-libraries.test.ts).
export function jsonSchemaOf(schema: Schema.Constraint, options?: Schema.ToJsonSchemaOptions): Schema.Json {
  const document = Schema.toJsonSchemaDocument(schema, options)
  const path = typeof document.schema.$ref === "string" ? JsonPointer.parseUriFragment(document.schema.$ref) : undefined
  const definition = path?.length === 2 && path[0] === "$defs" ? document.definitions[path[1]!] : undefined
  const { $ref: _reference, ...siblings } = document.schema
  const converted = JsonSchema.toDocumentDraft07({
    ...document,
    schema: definition === undefined ? document.schema : { ...definition, ...siblings },
  })
  return Schema.decodeUnknownSync(Schema.Json)({
    ...converted.schema,
    ...(Object.keys(converted.definitions).length ? { definitions: converted.definitions } : {}),
  })
}
