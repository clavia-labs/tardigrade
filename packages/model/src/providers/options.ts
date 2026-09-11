import { Schema } from "effect"
import { OpenAiSchema } from "@tardie/ai-openai"
import { Generated } from "@tardie/ai-anthropic"
import type { ModelProtocol } from "./directory"

const reasoning = OpenAiSchema.CreateResponse.fields.reasoning
const schemas = {
  "openai-responses": Schema.Struct({ reasoning }),
  "openai-chat-completions": Schema.Struct({ reasoning_effort: Schema.optionalKey(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"])) }),
  "anthropic-messages": Schema.Struct({
    thinking: Schema.optionalKey(Generated.BetaThinkingConfigParam),
    output_config: Schema.optionalKey(Schema.Struct({ effort: Schema.optionalKey(Schema.NullOr(Schema.Literals(["low", "medium", "high"]))) }))
  }),
  "bedrock-converse": Schema.Struct({ additionalModelRequestFields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) })
}

export type ModelOptionsByProtocol = { [P in ModelProtocol]: typeof schemas[P]["Type"] }
export type ProtocolOptions = { [P in ModelProtocol]: { readonly protocol: P; readonly options?: ModelOptionsByProtocol[P] } }[ModelProtocol]

// protocolOptionsOf validates host request options against the selected protocol (reasoning.test.ts).
export const protocolOptionsOf = (protocol: ModelProtocol, value: unknown): ProtocolOptions => {
  switch (protocol) {
    case "openai-responses": return { protocol, ...(value === undefined ? {} : { options: Schema.decodeUnknownSync(schemas[protocol], { onExcessProperty: "error" })(value) }) }
    case "openai-chat-completions": return { protocol, ...(value === undefined ? {} : { options: Schema.decodeUnknownSync(schemas[protocol], { onExcessProperty: "error" })(value) }) }
    case "anthropic-messages": return { protocol, ...(value === undefined ? {} : { options: Schema.decodeUnknownSync(schemas[protocol], { onExcessProperty: "error" })(value) }) }
    case "bedrock-converse": return { protocol, ...(value === undefined ? {} : { options: Schema.decodeUnknownSync(schemas[protocol], { onExcessProperty: "error" })(value) }) }
  }
}
