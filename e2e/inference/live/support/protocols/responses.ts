import type { ProtocolDriver } from "../config"

const opaqueValues = (value: unknown): ReadonlyArray<string> => {
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) => (key === "encrypted_content" || key === "signature") && typeof item === "string" && item.length > 0 ? [item] : opaqueValues(item))
}

const events = (body: string): ReadonlyArray<Record<string, unknown>> => body.split("\n").flatMap((line) => {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return []
  try { return [JSON.parse(line.slice(6)) as Record<string, unknown>] } catch { return [] }
})

export const responses: ProtocolDriver = {
  protocol: "openai-responses",
  responseEvidence: (body) => {
    const parts = events(body)
    return { opaqueParts: opaqueValues(parts).length, reasoningTokens: parts.reduce((sum, part) => sum + Number((part.response as { usage?: { output_tokens_details?: { reasoning_tokens?: number } } } | undefined)?.usage?.output_tokens_details?.reasoning_tokens ?? 0), 0) }
  },
  opaqueEvidence: (body) => {
    const items = new Map<string, unknown>()
    for (const event of events(body)) {
      const output = (event.response as { output?: ReadonlyArray<{ id?: string }> } | undefined)?.output
      if (output !== undefined) for (const item of output) { if (item.id !== undefined && !items.has(item.id)) items.set(item.id, item) }
      const item = event.item as { id?: string } | undefined
      if (event.type === "response.output_item.done" && item?.id !== undefined) items.set(item.id, item)
    }
    return opaqueValues([...items.values()])
  },
  followUpEvidence: (body, nonce) => ({ opaqueParts: opaqueValues(JSON.parse(body)).length, hasToolResult: body.includes(nonce) })
}
