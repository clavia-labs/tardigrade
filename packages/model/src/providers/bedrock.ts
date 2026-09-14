import { validatedConfig } from "./options"
import { BedrockLanguageModel } from "@tardie/ai-bedrock"
import { bedrockGatewayHandler } from "./bedrock-transport"
import type { ProviderLayer } from "./layer"

// providerLayer supplies the Bedrock Effect model and optional gateway transport (bedrock.test.ts).
export const providerLayer: ProviderLayer = (options) => {
  if (options.provider !== "bedrock") throw new Error(`The Bedrock layer cannot serve ${options.provider}; supply the matching providerLayer`)
  return BedrockLanguageModel.layer({ ...options, model: { ...options.model, config: validatedConfig(BedrockLanguageModel.ModelConfigSchema, options.model.config, options.unvalidatedConfig) }, client: options.gateway === undefined ? options.client : {
    ...options.client, requestHandler: bedrockGatewayHandler(options.gateway.apiKey, options.gateway.bounds)
  } })
}
