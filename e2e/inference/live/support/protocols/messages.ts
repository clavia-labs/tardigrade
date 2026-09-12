import type { ProtocolDriver } from "../config"

const parse = (body: string): ReadonlyArray<Record<string, unknown>> => body.split("\n").flatMap((line) => {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return []
  try { return [JSON.parse(line.slice(6)) as Record<string, unknown>] } catch { return [] }
})
const signatures = (value: unknown): ReadonlyArray<string> => value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => key === "signature" && typeof item === "string" && item.length > 0 ? [item] : signatures(item)) : []

export const messages: ProtocolDriver = {
  protocol: "anthropic-messages",
  responseEvidence: (body) => ({ opaqueParts: signatures(parse(body)).length, reasoningTokens: 0 }),
  opaqueEvidence: (body) => signatures(parse(body)),
  followUpEvidence: (body, nonce) => ({ opaqueParts: signatures(JSON.parse(body)).length, hasToolResult: body.includes(nonce) })
}
