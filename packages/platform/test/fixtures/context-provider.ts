import { Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { inferenceLayer } from "@clavia/tardigrade-model/services"
import type { PromptCaching } from "@clavia/tardigrade-model/prompt-cache"

export interface WireBlock {
  readonly type: string
  readonly text?: string
  readonly cache_control?: { readonly type: string; readonly ttl?: string } | null
  readonly prompt_cache_breakpoint?: { readonly mode: string } | null
}

interface WireMessage {
  readonly role?: string
  readonly content?: string | readonly WireBlock[]
}

export interface ContextRequest {
  readonly system?: readonly WireBlock[]
  readonly messages?: readonly WireMessage[]
  readonly input?: readonly WireMessage[]
}

type ToolCall = { readonly id: string; readonly name: string; readonly input: { readonly path: string; readonly content: string } }

// contextProvider runs native adapters against scripted HTTP responses for the context recovery scenario.
export function contextProvider(provider: "anthropic" | "openai" | "openrouter", options: {
  readonly promptCache?: false | Partial<PromptCaching>
  readonly calls: readonly ToolCall[]
  readonly observe: (request: ContextRequest) => boolean
}) {
  const model = provider === "anthropic" ? "claude-sonnet-4-5" : provider === "openai" ? "gpt-5.6" : "anthropic/claude-sonnet-4.5"
  const protocol = provider === "anthropic" ? "anthropic-messages" : provider === "openai" ? "openai-responses" : "openai-chat-completions"
  const reference = { provider, model_id: model }
  const lock = Layer.succeed(ModelLock, modelLockService(modelLockOf({ schema: 2,
    providers: { [provider]: { protocol, baseUrl: "https://fixture.invalid/v1", env: [] } },
    models: [{ ...reference, contextWindowTokens: 32_768 }],
  }), { allow: "*", default: reference }))
  let responses = 0
  const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request: ContextRequest = JSON.parse(await new globalThis.Response(init?.body as ConstructorParameters<typeof globalThis.Response>[0]).text())
    if (options.observe(request)) return new Promise<globalThis.Response>((_resolve, reject) => {
      const abort = () => reject(new Error("Fixture request aborted"))
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener("abort", abort, { once: true })
    })
    const call = options.calls[responses++]
    const events = responseEvents(provider, model, call)
    return new globalThis.Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  }, { preconnect: globalThis.fetch.preconnect })
  const native = inferenceLayer({ provider, endpoint: "https://fixture.invalid/v1",
    client: { apiKey: Redacted.make("fixture"), apiUrl: "https://fixture.invalid/v1" }, model: { model },
    retry: { backoffMs: [] }, ...(options.promptCache === undefined ? {} : { promptCache: options.promptCache }),
  }).pipe(Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))))
  const services = modelServices().pipe(Layer.provide(Layer.merge(native, lock)))
  return Layer.merge(modelInfo.pipe(Layer.provide(lock)), modelActs.pipe(Layer.provide(services)))
}

function responseEvents(provider: "anthropic" | "openai" | "openrouter", model: string, call: ToolCall | undefined): readonly object[] {
  if (provider === "openai") {
    const item = call
      ? { type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) }
      : { type: "message", id: "reply", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [], logprobs: [] }] }
    return [
      ...(call ? [] : [{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.output_text.delta", item_id: "reply", output_index: 0, content_index: 0, delta: "ok" }]),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response", created_at: 1, model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]
  }
  if (provider === "openrouter") return [{ id: "response", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
      : { role: "assistant", content: "ok" }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }]
  return [
    { type: "message_start", message: { id: "response", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]
}
