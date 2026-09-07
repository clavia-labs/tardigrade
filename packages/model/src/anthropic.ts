import { createAnthropicChat } from "@tanstack/ai-anthropic"
import { outputSchemaFor } from "./output"
import type { ModelAdapter } from "./adapter"

// anthropicAdapter binds the Anthropic Messages protocol through TanStack AI.
export const anthropicAdapter: ModelAdapter = {
  id: "tanstack/anthropic",
  protocols: ["anthropic-messages"],
  start: ({ config, request, mode, fetch, messages, tools, systemPrompts }) => {
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
        ...(outputSchema === undefined ? {} : { outputSchema }),
        logger: new Proxy({}, { get: () => () => {} }) as never
      } as never)
    }
  }
}
