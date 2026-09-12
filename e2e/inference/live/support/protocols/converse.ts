import type { ProtocolDriver } from "../config"

const signatures = (value: unknown): ReadonlyArray<string> => value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => key === "signature" && typeof item === "string" && item.length > 0 ? [item] : signatures(item)) : []

export const converse: ProtocolDriver = {
  protocol: "bedrock-converse",
  responseEvidence: (body) => ({ opaqueParts: signatures(JSON.parse(body)).length, reasoningTokens: 0 }),
  opaqueEvidence: (body) => signatures(JSON.parse(body)),
  followUpEvidence: (body, nonce) => ({ opaqueParts: signatures(JSON.parse(body)).length, hasToolResult: body.includes(nonce) })
}
