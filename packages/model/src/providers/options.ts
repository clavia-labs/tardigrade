import { Schema } from "effect"
import type { OpenAiLanguageModel } from "@tardie/ai-openai"
import type { OpenAiLanguageModel as CompatibleLanguageModel } from "@tardie/ai-openai-compat"
import type { AnthropicLanguageModel } from "@tardie/ai-anthropic"
import type { BedrockLanguageModel } from "@tardie/ai-bedrock"
import type { ModelProtocol } from "./directory"

export interface ModelOptionsByProtocol {
  readonly "openai-responses": NonNullable<Parameters<typeof OpenAiLanguageModel.layer>[0]["config"]>
  readonly "openai-chat-completions": NonNullable<Parameters<typeof CompatibleLanguageModel.layer>[0]["config"]>
  readonly "anthropic-messages": NonNullable<Parameters<typeof AnthropicLanguageModel.layer>[0]["config"]>
  readonly "bedrock-converse": BedrockLanguageModel.ModelConfig
}

export interface ProtocolOptions {
  readonly protocol: ModelProtocol
  readonly options?: Schema.JsonObject
}

// protocolOptionsOf checks JSON shape; the selected provider validates its settings at assembly (options.test.ts).
export const protocolOptionsOf = (protocol: ModelProtocol, value: unknown): ProtocolOptions => ({
  protocol,
  ...(value === undefined ? {} : { options: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value) })
})

// validatedConfig checks options before and after host limits are applied (options.test.ts).
export const validatedConfig = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown, original: unknown = value): S["Type"] => {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })
  if (original !== value) decode(original ?? {})
  return decode(value ?? {})
}
