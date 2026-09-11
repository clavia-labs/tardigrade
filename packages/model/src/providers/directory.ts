export const MODEL_PROTOCOLS = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "bedrock-converse"
] as const

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]

export interface ModelProviderConnection {
  readonly id: string
  readonly name: string
  readonly protocol: ModelProtocol
  readonly baseUrl?: string
  readonly region: boolean
}

// MODEL_PROVIDER_CONNECTIONS declares the provider presets whose setup defaults Tardigrade owns.
export const MODEL_PROVIDER_CONNECTIONS: ReadonlyArray<ModelProviderConnection> = [
  { id: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", region: false },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", region: false },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-chat-completions", baseUrl: "https://openrouter.ai/api/v1", region: false },
  { id: "vercel", name: "Vercel AI Gateway", protocol: "openai-responses", baseUrl: "https://ai-gateway.vercel.sh/v1", region: false },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", protocol: "openai-responses", region: false },
  { id: "azure", name: "Microsoft Foundry", protocol: "openai-responses", region: false },
  { id: "google", name: "Google AI", protocol: "openai-chat-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", region: false },
  { id: "google-vertex", name: "Google Vertex AI", protocol: "openai-chat-completions", region: false },
  { id: "amazon-bedrock", name: "Amazon Bedrock", protocol: "bedrock-converse", region: true }
]

export const modelProviderConnectionOf = (id: string): ModelProviderConnection | undefined =>
  MODEL_PROVIDER_CONNECTIONS.find((provider) => provider.id === id)

export const modelProtocolOf = (value: string): ModelProtocol => {
  if ((MODEL_PROTOCOLS as ReadonlyArray<string>).includes(value)) return value as ModelProtocol
  throw new Error(`model protocol must be one of ${MODEL_PROTOCOLS.join(", ")}, got ${JSON.stringify(value)}`)
}
