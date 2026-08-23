import { Schema } from "effect"

// ModelReference identifies a model through a host connection. A string uses the host's default connection.
export const ModelReference = Schema.Union([
  Schema.String,
  Schema.Struct({
    id: Schema.String,
    connection: Schema.optional(Schema.String)
  })
])

export type ModelReference = typeof ModelReference.Type
