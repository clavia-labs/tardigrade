import { calls, reasoning, thinking, redacted, providerEvents } from "../testing/fixtures"
import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema, Fiber, Deferred, Exit } from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { collectResponse } from "../stream/collect"
import { providerLayer } from "./layer"

const dynamicToolkit = Toolkit.make(Tool.dynamic("read", { parameters: Schema.Struct({ path: Schema.String }) }))
const toolkit = Toolkit.make(Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }), failureMode: "return" }))

for (const provider of ["openai", "anthropic"] as const) {
 for (const malformed of [false, true]) {
  test(`${provider}: replay and parallel calls (schema mismatch: ${malformed})`, async () => {
    const events = providerEvents(provider, malformed)
    const requests: Array<{ input?: unknown[]; messages?: Array<{ role: string; content: unknown[] }>; reasoning?: unknown; thinking?: unknown }> = []
    const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requests.push(JSON.parse(await new Response(init?.body).text()))
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: 1, ...event })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }, { preconnect: globalThis.fetch.preconnect })
    const layer = providerLayer(provider === "openai"
      ? { provider, client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: "gpt-5", config: { store: false, reasoning: { effort: "high" } } } }
      : { provider, client: { apiKey: Redacted.make("test") }, model: { model: "claude-sonnet-4-5", config: { max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 1024 } } } })
    const run = (prompt: Prompt.RawInput) => Effect.runPromise(collectResponse(prompt, toolkit).pipe(
      Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FetchHttpClient.Fetch, fetch)
    ))
    const first = await run("Read both files")
    expect(first.parts.filter((part) => part.type === "tool-call").map((part) => part.id)).toEqual(malformed ? ["a", "c"] : ["a", "b", "c"])
    expect(first.parts.some((part) => part.type === "tool-result")).toBe(false)
    const finish = first.parts.find((part) => part.type === "finish")
    expect(finish?.usage.inputTokens.total).toBe(10)
    expect(finish?.usage.outputTokens.total).toBe(5)
    if (malformed) expect(JSON.parse(JSON.stringify(first.parts)).filter((part: { type: string }) => part.type === "error")).toHaveLength(1)
    const restored = Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(JSON.stringify(first.continuation)))
    expect(restored.content.flatMap((message) => message.role === "assistant" ? message.content : []).filter((part) => part.type === "tool-call").map((part) => part.id)).toEqual(["a", "b", "c"])
    const results = Prompt.make([{ role: "tool", content: ["a", "b", "c"].map((id) => ({ type: "tool-result" as const, id, name: "read", result: malformed && id === "b" ? "Invalid path: expected string" : "contents", isFailure: malformed && id === "b" })) }])
    await run(Prompt.concat(restored, results))
    if (provider === "openai") {
      expect(requests[1]?.input).toEqual(expect.arrayContaining(reasoning))
      expect(requests[0]?.reasoning).toEqual({ effort: "high" })
    } else {
      expect(requests[1]?.messages?.find((message) => message.role === "assistant")?.content).toEqual(expect.arrayContaining([thinking, redacted]))
      expect(requests[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    }
  })
}

}

test("interrupting the turn aborts its HTTP request", async () => {
  let aborted = false
  const program = Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const fetch = Object.assign((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      Deferred.doneUnsafe(started, Effect.void)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
      })
    }, { preconnect: globalThis.fetch.preconnect })
    const turn = collectResponse("Check", toolkit).pipe(
      Effect.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: "gpt-5" } }).pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FetchHttpClient.Fetch, fetch)
    )
    const fiber = yield* Effect.forkChild(turn)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    return yield* Fiber.await(fiber)
  })
  const exit = await Effect.runPromise(Effect.scoped(program))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(aborted).toBe(true)
})

test("OpenAI dynamic JSON Schema tools survive response decoding", async () => {
  const fetch = Object.assign(async () => new Response(
    [
      { type: "response.output_item.done", output_index: 0, item: calls[0] },
      { type: "response.completed", response: { id: "response", created_at: 1, model: "gpt-5", status: "completed", output: [calls[0]], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  ), { preconnect: globalThis.fetch.preconnect })
  const run = collectResponse("Check", dynamicToolkit).pipe(
    Effect.provide(providerLayer({ provider: "openai", client: { apiKey: Redacted.make("test"), apiUrl: "https://fixture.invalid/v1" }, model: { model: "gpt-5" } }).pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FetchHttpClient.Fetch, fetch)
  )
  const response = await Effect.runPromise(run)
  expect(response.parts).toContainEqual(expect.objectContaining({ type: "tool-call", name: "read", params: { path: "a" } }))
})
