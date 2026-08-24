import { Schema } from "effect"

// ModelCoordinate identifies the provider and model an actor requests. The host supplies the provider connection.
export const ModelCoordinate = Schema.Struct({
  provider: Schema.String,
  model_id: Schema.String
})

export type ModelCoordinate = typeof ModelCoordinate.Type
