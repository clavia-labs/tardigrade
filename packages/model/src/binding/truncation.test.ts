import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import { agentMethods, infer, tool, outputValidateOnce } from "@clavia/tardigrade-agent"
import { actor } from "@clavia/tardigrade-core/actor"
import { createHost } from "@clavia/tardigrade-host/host"
import { inferenceLayer } from "./index"
import { providerEvents } from "../testing/fixtures"

const spec = { name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }

const fixture = (provider: "openai" | "anthropic", partial: boolean, truncated: boolean, segmented = false) => {
  const limits: number[] = []
  const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(await new Response(init?.body).text()) as { max_output_tokens?: number; max_tokens?: number }
    limits.push((provider === "openai" ? request.max_output_tokens : request.max_tokens)!)
    let events: Record<string, unknown>[] = JSON.parse(JSON.stringify(providerEvents(provider, false)))
    for (const event of events) {
      const item = event.item as Record<string, unknown> | undefined
      const delta = event.delta as Record<string, unknown> | undefined
      if (partial && item?.type === "function_call" && item.call_id === "b") item.arguments = '{"path":'
      if (partial && event.index === 3 && delta?.type === "input_json_delta") delta.partial_json = '{"path":'
    }
    if (truncated) {
      if (provider === "openai") {
        const end = events.at(-1)!
        end.type = "response.incomplete"
        const response = end.response as Record<string, unknown>
        response.status = "incomplete"
        response.incomplete_details = { reason: "max_output_tokens" }
      } else {
        const end = events.find((event) => event.type === "message_delta")!
        ;(end.delta as Record<string, unknown>).stop_reason = "max_tokens"
      }
    }
    if (segmented && provider === "openai") events = events.flatMap((event) => {
      const item = event.item as Record<string, unknown> | undefined
      return event.type === "response.output_item.done" && item?.type === "function_call"
        ? [{ type: "response.function_call_arguments.done", output_index: event.output_index, item_id: item.id, arguments: item.arguments }, event]
        : [event]
    })
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  }, { preconnect: globalThis.fetch.preconnect })
  const layer = inferenceLayer({ provider, model: { model: "fixture" }, maxOutputTokens: 150, endpoint: "https://fixture.invalid", client: { apiKey: Redacted.make("test") }, retry: { backoffMs: truncated ? [0, 0] : [] }, pricing: { promptUsdPerToken: 1, completionUsdPerToken: 2, cachedPromptUsdPerToken: 1 } }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return { layer, limits }
}

for (const provider of ["openai", "anthropic"] as const) {
  for (const scenario of ["complete-arguments", "partial-arguments", "malformed-completion", ...(provider === "openai" ? ["segmented-partial"] : [])]) {
    test(`${provider}: ${scenario} preserves usage without retry or dispatch`, async () => {
      const truncated = scenario !== "malformed-completion"
      const { layer, limits } = fixture(provider, scenario !== "complete-arguments", truncated, scenario === "segmented-partial")
      const action = await Effect.runPromise(Effect.flatMap(inferenceClient, (binding) => binding.react({ identity: { actor: "test", instance: "main", thread: "root", turn: "m1" }, system: "Read", trajectory: [], tools: [spec] })).pipe(Effect.provide(layer)))
      expect(limits).toEqual([150])
      expect(action.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })
      expect(action.finish?.metadata).toBeDefined()
      expect(action).toMatchObject({ kind: "fail", error: { reason: { _tag: truncated ? "UnknownError" : "ToolParameterValidationError" }, isRetryable: !truncated }, failure: { cause: truncated ? "output_limit" : "inference_error", attempts: 1 } })
      expect(action).not.toHaveProperty("failure.policy")
      expect(action).not.toHaveProperty("calls")
      expect(action).not.toHaveProperty("continuation")
    })
  }

  test(`${provider}: output limit is durable before any tool execution`, async () => {
    const { layer, limits } = fixture(provider, true, true)
    const executions: string[] = []
    const definition = actor({ name: "truncated-agent", methods: agentMethods, components: [infer([outputValidateOnce, tool({ spec, run: (_args, context) => Effect.sync(() => { executions.push(context.callId); return "contents" }) })], { models: { default: { provider, model_id: "fixture" }, allow: "*" } })] })
    const host = createHost({ actorName: "truncated-agent", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, layer) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text: "Read", at: 1 })
    await host.drive()
    const events = host.read("root")
    expect(limits).toEqual([150])
    expect(executions).toEqual([])
    expect(events.filter((event) => event.type === "ToolCalled")).toEqual([])
    expect(events.filter((event) => event.type === "ModelReturned")).toMatchObject([{ outcome: "failed", usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } }])
    expect(events.filter((event) => event.type === "TurnFailed")).toMatchObject([{ cause: "output_limit", error: { code: "UnknownError" } }])
  })
}
