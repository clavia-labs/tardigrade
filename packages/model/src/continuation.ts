import type { ProviderContinuation } from "@clavia/tardigrade-agent/inference/continuation"
import type { AgentMessage } from "@clavia/tardigrade-agent/projection/messages"
import type { ModelConfig, ModelFetch } from "./adapter"

type Part = Record<string, unknown>
const partOf = (value: unknown): Part | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Part : undefined

// continuationScopeOf fingerprints the complete endpoint without storing credentials or query values (continuation.test.ts).
export const continuationScopeOf = async (config: ModelConfig) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.baseUrl))
  const endpoint = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  return { protocol: config.protocol, provider: config.provider, model: config.model, endpoint }
}

// responseStateOf retains native output, including redacted blocks, only when the response contains reasoning (continuation.test.ts).
export const responseStateOf = async (events: readonly unknown[], config: ModelConfig): Promise<{ continuation?: ProviderContinuation; reasoning?: string }> => {
  let payload: Part[] = []
  const blocks = new Map<number, Part>()
  const inputs = new Map<number, string>()
  for (const value of events) {
    const event = partOf(value)
    if (event === undefined) continue
    if (config.protocol === "anthropic-messages") {
      if (Array.isArray(event.content)) payload = event.content as Part[]
      if (event.type === "content_block_start") {
        const block = partOf(event.content_block)
        if (block !== undefined) blocks.set(Number(event.index), { ...block })
      }
      if (event.type === "content_block_delta") {
        const block = blocks.get(Number(event.index))
        const delta = partOf(event.delta)
        if (block === undefined || delta === undefined) continue
        for (const field of ["thinking", "signature", "text"] as const) if (typeof delta[field] === "string") block[field] = String(block[field] ?? "") + delta[field]
        if (typeof delta.partial_json === "string") inputs.set(Number(event.index), (inputs.get(Number(event.index)) ?? "") + delta.partial_json)
      }
    } else if (config.protocol === "openai-responses") {
      if (event.type === "response.output_item.done" && partOf(event.item) !== undefined) blocks.set(Number(event.output_index), event.item as Part)
      const response = partOf(event.response) ?? event
      if (Array.isArray(response.output)) payload = response.output as Part[]
    }
  }
  if (payload.length === 0) payload = [...blocks.entries()].sort(([a], [b]) => a - b).map(([index, block]) => {
    const input = inputs.get(index)
    return input === undefined ? block : { ...block, input: JSON.parse(input) }
  })
  const reasoning = payload.filter((part) => part.type === "thinking" || part.type === "redacted_thinking" || part.type === "reasoning")
  if (reasoning.length === 0) return {}
  const text = reasoning.flatMap((part) => {
    if (typeof part.thinking === "string") return [part.thinking]
    return Array.isArray(part.summary) ? part.summary.flatMap((value) => {
      const summary = partOf(value)
      return typeof summary?.text === "string" ? [summary.text] : []
    }) : []
  }).filter((text) => text !== "").join("\n\n")
  return { continuation: { ...await continuationScopeOf(config), payload }, ...(text === "" ? {} : { reasoning: text }) }
}

// withContinuation restores complete native assistant responses after TanStack's lossy conversion (continuation.test.ts).
export const withContinuation = (fetch: ModelFetch, config: ModelConfig, messages: readonly AgentMessage[]): ModelFetch => async (input, init) => {
  if (config.protocol !== "anthropic-messages" && config.protocol !== "openai-responses") return fetch(input, init)
  if (!messages.some((message) => message.continuation !== undefined)) return fetch(input, init)
  const scope = await continuationScopeOf(config)
  const compatible = (continuation: ProviderContinuation | undefined) => continuation !== undefined &&
    continuation.protocol === scope.protocol && continuation.provider === scope.provider &&
    continuation.model === scope.model && continuation.endpoint === scope.endpoint
  if (!messages.some((message) => compatible(message.continuation))) return fetch(input, init)
  const request = input instanceof Request ? input : new Request(String(input), init)
  const body = JSON.parse(typeof init?.body === "string" ? init.body : await request.clone().text()) as Part
  const field = config.protocol === "anthropic-messages" ? "messages" : "input"
  const items = body[field]
  if (!Array.isArray(items)) throw new Error("provider request has no conversation for continuation replay")
  let cursor = 0
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const call = message.toolCalls?.[0]?.id
    const index = items.findIndex((item: Part, index: number) => index >= cursor && (config.protocol === "anthropic-messages"
      ? item.role === "assistant"
      : call === undefined ? item.role === "assistant" : item.type === "function_call" && item.call_id === call))
    if (index < 0) {
      if (compatible(message.continuation)) throw new Error("assistant response missing during continuation replay")
      continue
    }
    const count = config.protocol === "anthropic-messages" ? 1 : (message.toolCalls?.length ?? 0) + (message.content ? 1 : 0)
    if (compatible(message.continuation)) {
      const payload = message.continuation!.payload
      if (config.protocol === "anthropic-messages") items[index] = { ...items[index], content: payload }
      else items.splice(index, count, ...payload)
      cursor = index + (config.protocol === "anthropic-messages" ? 1 : payload.length)
    } else cursor = index + count
  }
  const headers = new Headers(init?.headers ?? request.headers)
  headers.delete("content-length")
  return fetch(input, { ...init, headers, body: JSON.stringify(body) })
}
