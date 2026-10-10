import { Schema } from "effect"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { Content } from "@clavia/tardigrade-model/object/content"

export const ToolReturnedV1 = Schema.Struct({
  type: Schema.Literal("ToolReturned"), version: Schema.Literal(1),
  callId: Schema.String, content: Content, error: Schema.NullOr(Schema.String),
  promise: Schema.optionalKey(ToolPromise),
})
