import type { LiveTarget, ProtocolDriver } from "./support/config"
import { chatCompletions } from "./support/protocols/chat-completions"
import { converse } from "./support/protocols/converse"
import { messages } from "./support/protocols/messages"
import { responses } from "./support/protocols/responses"

export const drivers: Readonly<Record<LiveTarget["protocol"], ProtocolDriver>> = {
  "openai-responses": responses,
  "openai-chat-completions": chatCompletions,
  "anthropic-messages": messages,
  "bedrock-converse": converse
}

const LIVE_TARGETS: ReadonlyArray<LiveTarget> = [
  { id: "openai-responses", protocol: "openai-responses", credential: "OPENAI_API_KEY", endpoint: "https://api.openai.com/v1", modelEnv: "TARDIE_LIVE_OPENAI_MODEL", contextWindowEnv: "TARDIE_LIVE_OPENAI_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "reasoning", "recovery"] },
  { id: "openrouter-chat-completions", protocol: "openai-chat-completions", credential: "OPENROUTER_API_KEY", endpoint: "https://openrouter.ai/api/v1", modelEnv: "TARDIE_LIVE_OPENROUTER_MODEL", contextWindowEnv: "TARDIE_LIVE_OPENROUTER_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "reasoning", "recovery"] },
  { id: "cloudflare-responses", protocol: "openai-responses", credential: "CLOUDFLARE_AIG_TOKEN", endpointEnv: "TARDIE_LIVE_CLOUDFLARE_BASE_URL", modelEnv: "TARDIE_LIVE_CLOUDFLARE_MODEL", contextWindowEnv: "TARDIE_LIVE_CLOUDFLARE_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "reasoning", "recovery"] },
  { id: "cloudflare-chat-completions", protocol: "openai-chat-completions", credential: "CLOUDFLARE_AIG_TOKEN", endpointEnv: "TARDIE_LIVE_CLOUDFLARE_BASE_URL", modelEnv: "TARDIE_LIVE_CLOUDFLARE_MODEL", contextWindowEnv: "TARDIE_LIVE_CLOUDFLARE_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "recovery"] },
  { id: "anthropic-messages", protocol: "anthropic-messages", credential: "ANTHROPIC_API_KEY", endpoint: "https://api.anthropic.com", modelEnv: "TARDIE_LIVE_ANTHROPIC_MODEL", contextWindowEnv: "TARDIE_LIVE_ANTHROPIC_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "reasoning", "recovery"] },
  { id: "bedrock-converse", protocol: "bedrock-converse", credential: "AWS_BEARER_TOKEN_BEDROCK", endpointEnv: "TARDIE_LIVE_BEDROCK_ENDPOINT", regionEnv: "TARDIE_LIVE_BEDROCK_REGION", modelEnv: "TARDIE_LIVE_BEDROCK_MODEL", contextWindowEnv: "TARDIE_LIVE_BEDROCK_CONTEXT_TOKENS", behaviors: ["completion", "tool-loop", "reasoning", "recovery"] }
]

export const targetById = (id: string): LiveTarget | undefined => LIVE_TARGETS.find((target) => target.id === id)
