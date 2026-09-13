import type { ProtocolDriver } from "../config"

const parse = (body: string): ReadonlyArray<Record<string, unknown>> => body.split("\n").flatMap((line) => {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return []
  try { return [JSON.parse(line.slice(6)) as Record<string, unknown>] } catch { return [] }
})
const reasoningValues = (value: unknown): ReadonlyArray<string> => {
  if (value === null || typeof value !== "object") return []
  if ("type" in value && value.type === "reasoning.encrypted" && "data" in value && typeof value.data === "string" && value.data.length > 0) return [value.data]
  return Object.entries(value).flatMap(([key, item]) => key === "signature" && typeof item === "string" && item.length > 0 ? [item] : reasoningValues(item))
}

export const chatCompletions: ProtocolDriver = {
  protocol: "openai-chat-completions",
  responseEvidence: (body) => ({ opaqueParts: reasoningValues(parse(body)).length, reasoningTokens: 0 }),
  opaqueEvidence: (body) => reasoningValues(parse(body)),
  followUpEvidence: (body, nonce) => ({ opaqueParts: reasoningValues(JSON.parse(body)).length, hasToolResult: body.includes(nonce) })
}
