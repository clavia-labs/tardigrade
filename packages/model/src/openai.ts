import { openaiCompatibleText } from "@tanstack/ai-openai/compatible"
import { compatibleResponseFormat } from "./output"
import type { ModelAdapter } from "./adapter"

// openAICompatibleAdapter binds the Responses and Chat Completions protocols through TanStack AI.
export const openAICompatibleAdapter: ModelAdapter = {
  id: "tanstack/openai-compatible",
  protocols: ["openai-responses", "openai-chat-completions"],
  start: ({ config, request, mode, maxTokens, fetch, messages, tools, systemPrompts }) => {
    const responseFormat = compatibleResponseFormat(request.output, mode)
    const adapter = openaiCompatibleText(config.model, {
      name: "tardigrade",
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      api: config.protocol === "openai-responses" ? "responses" : "chat-completions",
      maxRetries: 0,
      fetch
    })
    return {
      stream: adapter.chatStream({
        model: config.model,
        messages: messages as never,
        tools: tools as never,
        systemPrompts,
        modelOptions: {
          max_tokens: maxTokens,
          ...(responseFormat === undefined ? {} : { response_format: responseFormat })
        } as never,
        logger: new Proxy({}, { get: () => () => {} }) as never
      } as never)
    }
  }
}
