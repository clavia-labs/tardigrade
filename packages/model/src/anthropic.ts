import { createAnthropicChat } from "@tanstack/ai-anthropic"
import { protocolOptionsOf } from "./reasoning"
import { outputSchemaFor } from "./output"
import type { ModelAdapter } from "./adapter"

// anthropicAdapter binds the Anthropic Messages protocol through TanStack AI.
export const anthropicAdapter: ModelAdapter = {
  id: "tanstack/anthropic",
  protocols: ["anthropic-messages"],
  start: ({ config, request, mode, maxTokens, fetch, messages, tools, systemPrompts }) => {
    const options = protocolOptionsOf(config.protocol, config.options).options
    if (options?.thinking?.type === "enabled" && options.thinking.budget_tokens >= maxTokens) {
      throw new Error("options.thinking.budget_tokens must be less than the request output token limit; set maxTokensLadder and maxOutputTokens accordingly")
    }
    const outputSchema = request.output?.kind === "contract" && mode.kind === "native"
      ? outputSchemaFor(request.output, mode)
      : undefined
    const adapter = createAnthropicChat(config.model as never, config.apiKey, {
      baseURL: config.baseUrl,
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
          ...options
        },
        ...(outputSchema === undefined ? {} : { outputSchema }),
        logger: new Proxy({}, { get: () => () => {} }) as never
      } as never)
    }
  }
}
