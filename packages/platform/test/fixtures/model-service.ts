import type { Schema } from "effect"

const DEFAULT_MODEL_FIXTURE_POLICY = { chunkChars: 8, chunkDelayMs: 0 }
export interface ModelReply {
  readonly text?: string
  readonly tools?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
  readonly status?: number
  readonly retryAfter?: string
  readonly chunkChars?: number
  readonly chunkDelayMs?: number
  readonly disconnectAfter?: number
}

// modelService serves scripted chat completions and records the wire requests and stream lifecycle.
export function modelService() {
  const replies: ModelReply[] = []
  const requests: Schema.Json[] = []
  const keys: (string | null)[] = []
  const streams: { sent: number; status: "open" | "completed" | "cancelled" | "disconnected" }[] = []
  const fetch = async (request: Request) => {
    const input = await request.json() as { model: string; stream?: boolean }
    requests.push(input)
    keys.push(request.headers.get("Idempotency-Key"))
    const reply = replies.shift()
    if (!reply) return Response.json({ error: { message: "No scripted model response", type: "fixture" } }, { status: 500 })
    if (reply.status) return Response.json({ error: { message: "Scripted model failure", type: "rate_limit_exceeded" } }, { status: reply.status, headers: reply.retryAfter === undefined ? {} : { "retry-after": reply.retryAfter } })
    const policy = { ...DEFAULT_MODEL_FIXTURE_POLICY, ...reply }
    if (!Number.isSafeInteger(policy.chunkChars) || policy.chunkChars < 1 || !Number.isFinite(policy.chunkDelayMs) || policy.chunkDelayMs < 0) throw new Error("Invalid model fixture chunk policy")
    const chunks = (text: string) => Array.from({ length: Math.ceil(text.length / policy.chunkChars) }, (_, index) => text.slice(index * policy.chunkChars, (index + 1) * policy.chunkChars))
    const envelope = { id: `model-${requests.length}`, created: 0, model: input.model }
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    const finish_reason = reply.tools?.length ? "tool_calls" : "stop"
    if (!input.stream) return Response.json({ ...envelope, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply.text ?? "", ...(reply.tools ? { tool_calls: reply.tools.map(tool => ({ id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } })) } : {}) }, finish_reason }], usage })
    const deltas: object[] = [{ role: "assistant", content: "" }, ...chunks(reply.text ?? "").map(content => ({ content }))]
    for (const [index, tool] of (reply.tools ?? []).entries()) {
      deltas.push({ tool_calls: [{ index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }] })
      for (const arguments_ of chunks(tool.arguments)) deltas.push({ tool_calls: [{ index, function: { arguments: arguments_ } }] })
    }
    const frames = [...deltas.map(delta => ({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })), { ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }], usage }].map(frame => `data: ${JSON.stringify(frame)}\n\n`)
    frames.push("data: [DONE]\n\n")
    const stream: typeof streams[number] = { sent: 0, status: "open" }
    streams.push(stream)
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (policy.chunkDelayMs) await new Promise(resolve => setTimeout(resolve, policy.chunkDelayMs))
        if (stream.status !== "open") return
        if (reply.disconnectAfter !== undefined && stream.sent >= reply.disconnectAfter) { stream.status = "disconnected"; controller.error(new Error("Scripted model disconnect")); return }
        const frame = frames[stream.sent++]
        if (frame === undefined) { stream.status = "completed"; controller.close() }
        else controller.enqueue(new TextEncoder().encode(frame))
      },
      cancel() { stream.status = "cancelled" },
    }), { headers: { "content-type": "text/event-stream" } })
  }
  return { fetch, enqueue: (...script: readonly ModelReply[]) => { replies.push(...script) }, inspect: () => ({ requests: structuredClone(requests), keys: [...keys], streams: structuredClone(streams), remaining: replies.length }) }
}
