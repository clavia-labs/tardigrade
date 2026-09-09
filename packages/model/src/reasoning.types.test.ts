import { modelAdapters, type ModelConfig } from "./adapter"
import { infer } from "./model"
import type { ModelProviderConfig } from "./config"
import type { ProtocolOptions } from "./reasoning"

const connection = { baseUrl: "https://model.test", apiKey: "test", model: "test", provider: "test", contextWindowTokens: 128_000 }
const provider = { baseUrl: "https://model.test", env: ["KEY"] }

void ({ ...connection, protocol: "anthropic-messages", options: { thinking: { type: "adaptive" }, output_config: { effort: "max" } } } satisfies ModelConfig);
void ({ ...connection, protocol: "openai-responses", options: { reasoning: { effort: "high" } } } satisfies ModelConfig);
void ({ ...connection, protocol: "openai-chat-completions", options: { reasoning_effort: "none" } } satisfies ModelConfig);

// @ts-expect-error OpenAI does not accept Anthropic thinking.
void ({ ...connection, protocol: "openai-responses", options: { thinking: { type: "adaptive" } } } satisfies ModelConfig);
// @ts-expect-error Chat Completions does not accept Anthropic effort levels.
void ({ ...connection, protocol: "openai-chat-completions", options: { reasoning_effort: "max" } } satisfies ModelConfig);
// @ts-expect-error Bedrock controls are unsupported, including an empty object.
void ({ ...connection, protocol: "bedrock-converse", options: {} } satisfies ModelConfig);
// @ts-expect-error Host model maps retain the provider protocol restriction.
void ({ ...provider, protocol: "openai-responses", models: { model: { options: { thinking: { type: "adaptive" } } } } } satisfies ModelProviderConfig);
// @ts-expect-error A Bedrock model cannot specify even empty request options.
void ({ ...provider, protocol: "bedrock-converse", models: { model: { options: {} } } } satisfies ModelProviderConfig);

const mismatched = { protocol: "openai-responses", options: { reasoning: { effort: "high" }, thinking: { type: "adaptive" } } } as const
// @ts-expect-error Existing variables also reject mixed controls, beyond excess-property checks.
void (mismatched satisfies ProtocolOptions);

// inferRejectsMixedControls exercises the generic inference entry point without making a request.
export const inferRejectsMixedControls = () => {
  // @ts-expect-error Inference cannot widen the discriminant to admit mixed controls.
  infer({ ...connection, ...mismatched }, modelAdapters())
}
