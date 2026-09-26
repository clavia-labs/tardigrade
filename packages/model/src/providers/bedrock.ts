import { inferenceLayer as sharedInferenceLayer } from "../services"
import { DEFAULT_BEDROCK_TOOL_HISTORY, validatedConfig } from "./options"
import { BedrockLanguageModel } from "@tardie/ai-bedrock"
import { bedrockGatewayHandler } from "./bedrock-transport"
import type { ProviderLayer, ProviderOptions } from "./layer"
import type { BedrockOptions } from "./bedrock-contract"

export type { ClientOptions, ModelConfig, Send } from "@tardie/ai-bedrock/BedrockLanguageModel"

// BedrockProviderOptions exposes SDK client and model settings at the optional provider entry point (bedrock.test.ts).
export type BedrockProviderOptions = Omit<BedrockOptions, "client"> & {
  readonly client: BedrockLanguageModel.ClientOptions
  readonly unvalidatedConfig?: unknown
}

// providerLayer supplies the Bedrock Effect model and optional gateway transport (bedrock.test.ts).
export function providerLayer(options: BedrockProviderOptions): ReturnType<ProviderLayer>
export function providerLayer(options: ProviderOptions): ReturnType<ProviderLayer>
export function providerLayer(options: BedrockProviderOptions | ProviderOptions): ReturnType<ProviderLayer> {
  if (options.provider !== "bedrock") throw new Error(`The Bedrock layer cannot serve ${options.provider}; supply the matching providerLayer`)
  const config = validatedConfig(BedrockLanguageModel.ModelConfigSchema, options.model.config, options.unvalidatedConfig)
  return BedrockLanguageModel.layer({ ...options, model: { ...options.model, config: { ...config, toolHistory: config.toolHistory ?? DEFAULT_BEDROCK_TOOL_HISTORY } }, client: options.gateway === undefined ? options.client : {
    ...options.client, requestHandler: bedrockGatewayHandler(options.gateway.apiKey, options.gateway.bounds)
  } })
}

// inferenceLayer supplies Bedrock SDK clients with the shared inference policy (packages/agent/src/model/integration/providers/bedrock.test.ts).
export const inferenceLayer = (options: BedrockProviderOptions & Omit<Parameters<typeof sharedInferenceLayer>[0], "provider" | "client" | "model">) => sharedInferenceLayer({ ...options, client: {} }, (configured) => {
  if (configured.provider !== "bedrock") throw new Error(`The Bedrock layer cannot serve ${configured.provider}; supply the matching providerLayer`)
  return providerLayer({ ...configured, client: options.client })
})
