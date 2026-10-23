import { Schema } from "effect"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { Content } from "@clavia/tardigrade-model/object/content"

const fields = { type: Schema.Literal("ToolReturned"), tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, providerId: Schema.String })), turnId: Schema.optionalKey(Schema.String), callId: Schema.String, error: Schema.NullOr(Schema.String), promise: Schema.optionalKey(ToolPromise) }
export const ToolReturnedV0 = Schema.Union([
  Schema.Struct({ ...fields, output: Schema.String, content: Schema.optionalKey(Content) }),
  Schema.Struct({ ...fields, output: Schema.optionalKey(Schema.String), content: Content }),
])
