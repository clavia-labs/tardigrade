import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { codeMode, output, outputRepairFor, renderOf } from "tardie"

// reqOf wraps a trajectory in the render the actor would derive: the code surface half.
const surfaceRender = renderOf([codeMode], [])
const reqOf = (trajectory: ReadonlyArray<Event>) => ({ trajectory, ...surfaceRender })
import { Infer } from "tardie"
import { actionOf, bedrockAdapter, DEFAULT_STREAM_BOUNDS, ladderOf, modelAskOf, modelIdOf, infer, retryAfterMsOf, throttleDelayMs } from "./model"
import { capabilityOf, converseOutputConfig, outputPreflight, PROVEN_OUTPUT_CAPABILITIES } from "./output"
import type { Action } from "tardie/events"
import type { Event } from "@clavia/tardigrade-core/event"

// The model binding: the trajectory renders into the provider conversation, the streamed reply
// decodes into one Action, and the whole loop round-trips through a fake OpenAI-compatible SSE
// endpoint. No real provider is touched. Request-building (renderMessages, modelRequest) is domain
// and tested in agent/request.test.ts.

describe("actionOf", () => {
  test("a tool call acts, with its prose riding along", () => {
    const action = actionOf({
      content: "let me check",
      toolCalls: [{ id: "call_9", type: "function", function: { name: "execute", arguments: '{"code":"return 2"}' } }]
    } as never)
    expect(action).toEqual({ kind: "call", callId: "call_9", name: "execute", arguments: { code: "return 2" }, text: "let me check" })
  })

  test("plain text completes; nothing throws", () => {
    expect(actionOf({ content: "all done", toolCalls: [] } as never)).toEqual({ kind: "complete", output: "all done" })
    expect(() => actionOf({ content: "", toolCalls: [] } as never)).toThrow()
  })

  test("a final response completes and carries its text verbatim, JSON or prose", () => {
    // Nothing here judges a contract: the actor validates every completion before it records a
    // terminal (tardie, runtime/infer.ts, completionOf).
    const structured = JSON.stringify({ aspects: [{ name: "a" }] })
    expect(actionOf({ content: structured, toolCalls: [] } as never)).toEqual({ kind: "complete", output: structured })
  })

  test("a provider that declined leaves neither text nor a call, and says so", () => {
    expect(() => actionOf({ content: "", toolCalls: [], finishReason: "content_filter" } as never)).toThrow("refused")
    expect(() => actionOf({ content: "", toolCalls: [], finishReason: "stop" } as never)).toThrow("neither text nor a tool call")
  })
})

// The scout contract a research task declares, in the profile both wires send unchanged.
const SCOUT = output({
  name: "scout",
  schema: {
    type: "object",
    properties: {
      aspects: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"],
          additionalProperties: false
        }
      }
    },
    required: ["aspects"],
    additionalProperties: false
  }
})

const declared = (): ReadonlyArray<Event> => [
  { type: "MessageReceived", id: "m1", text: "decompose this topic", output: { name: SCOUT.name, schema: SCOUT.schema }, at: 1 }
]

describe("the output capability", () => {
  test("a named provider this repository read the wire for is proven; an unnamed endpoint is not", () => {
    expect(capabilityOf({ provider: "openai" })).toEqual(PROVEN_OUTPUT_CAPABILITIES["openai"]!)
    expect(capabilityOf({ provider: "bedrock" })).toEqual(PROVEN_OUTPUT_CAPABILITIES["bedrock"]!)
    expect(capabilityOf({ provider: "some-gateway" })).toBeUndefined()
    expect(capabilityOf({})).toBeUndefined()
    // A configuration may declare what the provider name cannot prove, and it wins.
    expect(capabilityOf({ provider: "openai", output: { guarantee: "none", withTools: false } })).toEqual({
      guarantee: "none",
      withTools: false
    })
  })

  test("preflight passes a proven endpoint, and refuses an unproven one by name", () => {
    const request = { output: { contract: SCOUT, implementation: { name: "native" as const, guarantee: "native" as const, onMismatch: "fail" as const } }, tools: [] }
    expect(outputPreflight(request, { provider: "openai", model: "gpt-5.2" })).toEqual([])
    const refused = outputPreflight(request, { model: "some-model" }).join(" ")
    expect(refused).toContain("declares no structured output capability")
    expect(refused).toContain("some-model")
    expect(outputPreflight(request, { model: "m", output: { guarantee: "native", withTools: true } })).toEqual([])
  })

  test("an implementation that asks for no guarantee preflights clean anywhere", () => {
    const repair = renderOf([codeMode, outputRepairFor()], []).output
    const request = { output: { contract: SCOUT, implementation: repair }, tools: [] }
    expect(outputPreflight(request, { model: "m" })).toEqual([])
  })

  test("an endpoint that cannot carry a schema beside tools refuses before spend, never a second call", () => {
    const request = { output: { contract: SCOUT, implementation: { name: "native" as const, guarantee: "native" as const, onMismatch: "fail" as const } }, tools: [{}] }
    const config = { provider: "narrow", model: "m", output: { guarantee: "native" as const, withTools: false } }
    expect(outputPreflight(request, config).join(" ")).toContain("cannot carry the contract")
    expect(outputPreflight({ ...request, tools: [] }, config)).toEqual([])
  })

  test("a schema outside the profile refuses before spend, whatever the endpoint promised", () => {
    const loose = { name: "loose", schema: { type: "object", properties: { a: { type: "string" } }, required: [] } }
    const request = { output: { contract: loose, implementation: { name: "native" as const, guarantee: "native" as const, onMismatch: "fail" as const } }, tools: [] }
    expect(outputPreflight(request, { provider: "openai", model: "m" }).join(" ")).toContain("outside the schema profile")
  })
})

describe("the Converse output surface", () => {
  test("the contract maps onto outputConfig.textFormat, with the schema as a JSON string", () => {
    expect(converseOutputConfig({ contract: SCOUT, implementation: { name: "native", guarantee: "native", onMismatch: "fail" } })).toEqual({
      textFormat: {
        type: "json_schema",
        structure: { jsonSchema: { name: "scout", schema: JSON.stringify(SCOUT.schema) } }
      }
    })
  })

  test("buildInput sets the native surface, and never a forced tool", () => {
    const config = { baseUrl: "https://bedrock.test/us-east-1", apiKey: "k", model: "anthropic.claude-sonnet", provider: "bedrock" }
    const request = { contract: SCOUT, implementation: { name: "native" as const, guarantee: "native" as const, onMismatch: "fail" as const } }
    const options = { model: config.model, messages: [{ role: "user", content: "go" }], systemPrompts: ["be brief"], tools: [] }
    const withContract = bedrockAdapter(config, 4096, DEFAULT_STREAM_BOUNDS, request).buildInput(options as never)
    expect(withContract.outputConfig).toEqual(converseOutputConfig(request))
    expect(JSON.stringify(withContract.toolConfig ?? {})).not.toContain("scout")
    expect(withContract.inferenceConfig).toMatchObject({ maxTokens: 4096 })
    // No contract, no output surface at all.
    expect(bedrockAdapter(config, 4096, DEFAULT_STREAM_BOUNDS).buildInput(options as never).outputConfig).toBeUndefined()
  })
})

const sse = (events: ReadonlyArray<unknown>): Response => {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("infer end to end", () => {
  test("a streamed tool call becomes a call action", async () => {
    let requested: { url: string; body: unknown } | null = null
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      requested = { url: request.url, body: JSON.parse(await request.text()) }
      return sse([
        { id: "r1", choices: [{ index: 0, delta: { role: "assistant", content: "on it" } }] },
        {
          id: "r1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_7", type: "function", function: { name: "execute", arguments: '{"code":"return 42"}' } }
                ]
              }
            }
          ]
        },
        { id: "r1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
      ])
    }) as typeof globalThis.fetch
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: fetchImpl
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) =>
        model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "compute", at: 1 }]))
      ).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    expect(action).toMatchObject({ kind: "call", callId: "call_7", name: "execute", arguments: { code: "return 42" }, text: "on it" })
    const body = requested!.body as { messages: ReadonlyArray<{ role: string }>; tools: ReadonlyArray<unknown> }
    expect(requested!.url).toContain("model.test")
    expect(body.messages.some((m) => m.role === "system")).toBe(true)
    expect(body.tools.length).toBe(1)
  })

  test("a streamed text reply becomes a completion", async () => {
    const fetchImpl = (async () =>
      sse([
        { id: "r2", choices: [{ index: 0, delta: { role: "assistant", content: "the answer " } }] },
        { id: "r2", choices: [{ index: 0, delta: { content: "is 4" } }] },
        { id: "r2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])) as unknown as typeof globalThis.fetch
    const layer = infer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", fetch: fetchImpl })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "2+2?", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(action).toEqual({ kind: "complete", output: "the answer is 4" })
  })

  test("a declared contract rides response_format strictly, beside the tools and with no answer tool", async () => {
    let body: {
      tools?: ReadonlyArray<{ function?: { name?: string } }>
      tool_choice?: unknown
      messages?: ReadonlyArray<{ role: string; content?: string }>
      response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } }
    } | null = null
    const answer = JSON.stringify({ aspects: [{ name: "a", description: "b" }] })
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await request.text())
      return sse([
        { id: "r3", choices: [{ index: 0, delta: { role: "assistant", content: answer } }] },
        { id: "r3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])
    }) as typeof globalThis.fetch
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "gpt-5.2",
      provider: "openai",
      fetch: fetchImpl
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(declared()))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    // The structured response is the completion, decoded from the content the schema constrained.
    expect(action).toEqual({ kind: "complete", output: answer })
    const sent = body!
    expect(sent.response_format).toMatchObject({ type: "json_schema" })
    expect(sent.response_format?.json_schema).toMatchObject({ name: "structured_output", strict: true })
    // The schema reaches the wire unchanged, which is what the supported profile buys.
    expect(sent.response_format?.json_schema?.schema).toEqual(SCOUT.schema as never)
    // The work tools still ride the same call, and no tool stands for the answer.
    expect(sent.tools?.map((t) => t.function?.name)).toEqual(["execute"])
    expect(sent.tool_choice).toBeUndefined()
    expect(JSON.stringify(sent.tools)).not.toContain("answer")
    const system = sent.messages?.find((m) => m.role === "system")?.content ?? ""
    expect(system).not.toContain("answer tool")
    expect(system).not.toContain("scout")
    expect(system).not.toContain("schema")
  })

  test("an implementation that asks for no guarantee sends no response_format at all", async () => {
    let body: { response_format?: unknown } | null = null
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await request.text())
      return sse([
        { id: "r4", choices: [{ index: 0, delta: { role: "assistant", content: "{}" } }] },
        { id: "r4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])
    }) as typeof globalThis.fetch
    const layer = infer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", fetch: fetchImpl })
    const repaired = renderOf([codeMode, outputRepairFor()], declared())
    await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react({ trajectory: declared(), ...repaired })).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(body!.response_format).toBeUndefined()
  })

  test("an unsupported contract fails before the fetch, so nothing is spent", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return sse([])
    }) as unknown as typeof globalThis.fetch
    // No provider name and no declared capability: the endpoint promises nothing.
    const layer = infer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "mystery", fetch: fetchImpl })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(declared()))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect(calls).toBe(0)
    expect(action.kind).toBe("fail")
    expect((action as { failure?: { cause?: string; attempts?: number } }).failure).toMatchObject({
      cause: "output_unsupported",
      attempts: 0
    })
    expect((action as { error: string }).error).toContain("mystery")
    expect(action.usage).toBeUndefined()
  })

  test("a refusal is its own failure class, keeps its bill, and the ladder does not climb it", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return sse([
        { id: "r5", choices: [{ index: 0, delta: { role: "assistant" } }] },
        { id: "r5", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }], usage: { prompt_tokens: 11, completion_tokens: 0 } }
      ])
    }) as unknown as typeof globalThis.fetch
    const layer = infer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", provider: "openai", fetch: fetchImpl, sleep: async () => {} })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(declared()))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect(calls).toBe(1)
    expect((action as { failure?: { cause?: string } }).failure).toMatchObject({ cause: "refused" })
    // A refusal still spent the prompt, so the turn records what it cost.
    expect(action.usage).toMatchObject({ promptTokens: 11 })
  })

  test("the attempt key rides as the Idempotency-Key header; absent, no header", async () => {
    const seen: Array<string | null> = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      seen.push(request.headers.get("Idempotency-Key"))
      return sse([
        { id: "r3", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
        { id: "r3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])
    }) as typeof globalThis.fetch
    const layer = infer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", fetch: fetchImpl })
    const trajectory = [{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]
    await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(trajectory), "m1/infer/0")).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(trajectory))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    expect(seen).toEqual(["m1/infer/0", null])
  })
})

const usageChunk = (usage: Record<string, unknown>) => ({ id: "u", choices: [], usage })

describe("infer: cost provenance", () => {
  const okText = [
    { id: "r", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
    { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ]
  const table = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }

  test("a billed cost is provider, an omitted cost is table or unknown", async () => {
    const billed = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          infer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            provider: "openai",
            pricing: table,
            fetch: (async () => sse([...okText, usageChunk({ prompt_tokens: 10, completion_tokens: 4, cost: 0 })])) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(billed).toMatchObject({
      kind: "complete",
      output: "ok",
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        costUsd: 0,
        costSource: "provider",
        provider: "openai",
        model: "test-model"
      }
    })

    const filled = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          infer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            provider: "openai",
            pricing: table,
            fetch: (async () => sse([...okText, usageChunk({ prompt_tokens: 10, completion_tokens: 4 })])) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(filled.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 10 * 0.001 + 4 * 0.002,
      costSource: "table",
      provider: "openai",
      model: "test-model"
    })

    const unknown = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          infer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            fetch: (async () => sse(okText)) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(unknown).toEqual({ kind: "complete", output: "ok" })
  })
})

// A throttle-shaped failure (429, 5xx, a stream timeout) retries inside the one act. Exhaustion
// returns a failed action that the agent records as a resumable terminal. `sleep` is the test seam
// that swaps the real backoff wait for an instant one, so these run in milliseconds.
describe("infer: throttle-shaped retry", () => {
  const okStream = () =>
    sse([
      { id: "r1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
      { id: "r1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ])

  test("a 429 then success: one in-act retry, no died mark, the delay is jittered off the first base", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return calls === 1 ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }) : okStream()
    }) as unknown as typeof globalThis.fetch
    const slept: Array<number> = []
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(action).toEqual({ kind: "complete", output: "ok" })
    expect(calls).toBe(2)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThanOrEqual(0)
    expect(slept[0]).toBeLessThan(2_000)
  })

  test("retries exhaust after the bounded set and report the effective policy", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: "upstream trouble" } }), { status: 503 })
    }) as unknown as typeof globalThis.fetch
    const slept: Array<number> = []
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("retries exhausted after 4 attempts"),
      failure: {
        cause: "inference_attempts_exhausted",
        attempts: 4,
        policy: {
          throttleRetryDelaysMs: [2_000, 8_000, 30_000],
          stream: { firstChunkMs: 90_000, idleMs: 90_000, totalMs: 300_000 }
        }
      }
    })
    // Four tries total: the first, plus one retry per configured backoff base.
    expect(calls).toBe(4)
    expect(slept).toHaveLength(3)
  })

  test("a non-throttle-shaped failure (a 400) never retries", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })
    }) as unknown as typeof globalThis.fetch
    const slept: Array<number> = []
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({
      kind: "fail",
      error: expect.stringContaining("failed after 1 attempt"),
      failure: { cause: "inference_error", attempts: 1 }
    })
    expect(calls).toBe(1)
    expect(slept).toHaveLength(0)
  })

  test("Bun's timed-out wording enters the bounded retry policy", async () => {
    let calls = 0
    const layer = infer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: (() => {
        calls += 1
        return Promise.reject(new Error("AbortError: The operation timed out"))
      }) as unknown as typeof globalThis.fetch,
      throttleRetryDelaysMs: [0],
      sleep: () => Promise.resolve()
    })

    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({
      kind: "fail",
      failure: { cause: "inference_attempts_exhausted", attempts: 2 }
    })
    expect(calls).toBe(2)
  })
})

describe("model selection", () => {
  const env = { MODEL_ID: "default-id", MODEL_OPUS_ID: "opus-id", MODEL_SONNET_ID: "sonnet-id" }
  test("names resolve through env, absent and unknown fall to the default", () => {
    expect(modelIdOf(env, "opus")).toBe("opus-id")
    expect(modelIdOf(env, "sonnet")).toBe("sonnet-id")
    expect(modelIdOf(env, undefined)).toBe("default-id")
    expect(modelIdOf(env, "gpt")).toBe("default-id")
    expect(modelIdOf({ MODEL_ID: "only" }, "opus")).toBe("only")
  })
  test("the ask rides the latest brief in the trajectory", () => {
    expect(modelAskOf([])).toBeUndefined()
    expect(
      modelAskOf([
        { type: "MessageReceived", id: "m1", text: "a", model: "opus", at: 1 } as never,
        { type: "CodeSettled", execId: "e1", at: 2 } as never
      ])
    ).toBe("opus")
    expect(
      modelAskOf([
        { type: "MessageReceived", id: "m1", text: "a", model: "opus", at: 1 } as never,
        { type: "MessageReceived", id: "m2", text: "b", at: 2 } as never
      ])
    ).toBe("opus")
  })
})

describe("retry-after", () => {
  const NOW = 1_000_000

  test("reads seconds and date forms, from any seat a failure carries headers in", () => {
    expect(retryAfterMsOf({ headers: { "Retry-After": "7" } }, NOW)).toBe(7_000)
    expect(retryAfterMsOf({ responseHeaders: { "retry-after": "2" } }, NOW)).toBe(2_000)
    expect(retryAfterMsOf({ cause: { headers: new Headers({ "retry-after": "3" }) } }, NOW)).toBe(3_000)
    const at = new Date(NOW + 5_000).toUTCString()
    expect(retryAfterMsOf({ headers: { "retry-after": at } }, NOW)).toBeGreaterThanOrEqual(4_000)
    expect(retryAfterMsOf({ headers: {} }, NOW)).toBeUndefined()
    expect(retryAfterMsOf({}, NOW)).toBeUndefined()
  })

  test("a stated wait within the ceiling is honored; past it, retries stop", () => {
    const stated = throttleDelayMs({ headers: { "retry-after": "7" } }, 0, NOW)
    expect(stated).toBeGreaterThanOrEqual(7_000)
    expect(stated).toBeLessThan(8_000)
    expect(throttleDelayMs({ headers: { "retry-after": "300" } }, 0, NOW)).toBeUndefined()
  })

  test("no stated wait falls back to the ladder, and the ladder still bounds retries", () => {
    const fallback = throttleDelayMs({}, 1, NOW)
    expect(fallback).toBeGreaterThanOrEqual(0)
    expect(fallback).toBeLessThanOrEqual(8_000)
    expect(throttleDelayMs({ headers: { "retry-after": "1" } }, 3, NOW)).toBeUndefined()
  })

  test("a caller-supplied ladder sets the retry count and the Retry-After ceiling", () => {
    const short = [100]
    expect(throttleDelayMs({}, 0, NOW, short)).toBeLessThanOrEqual(100)
    expect(throttleDelayMs({}, 1, NOW, short)).toBeUndefined()
    expect(throttleDelayMs({ headers: { "retry-after": "1" } }, 0, NOW, short)).toBeUndefined()
  })
})


describe("truncation", () => {
  const sse = (events: ReadonlyArray<Record<string, unknown>>): Response =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })

  const cut = (text: string, usage?: Record<string, unknown>) =>
    sse([
      { choices: [{ delta: { content: text }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "length", index: 0 }] },
      ...(usage === undefined ? [] : [{ choices: [], usage }])
    ])
  const whole = (text: string, usage?: Record<string, unknown>) =>
    sse([
      { choices: [{ delta: { content: text }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ...(usage === undefined ? [] : [{ choices: [], usage }])
    ])

  test("a cut answer retries up the ladder under a fresh idempotency key, and completes", async () => {
    let calls = 0
    const keys: Array<string | null> = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      keys.push(request.headers.get("Idempotency-Key"))
      return calls++ === 0 ? cut("half an ans") : whole("the whole answer")
    }) as unknown as typeof fetch
    const layer = infer({ provider: "openai", model: "m", baseUrl: "https://x", apiKey: "k", fetch: fetchImpl as never })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]), "t1/infer/0")).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<{ kind: string; output?: string }>
    )
    expect(calls).toBe(2)
    expect(action.kind).toBe("complete")
    expect(action.output).toBe("the whole answer")
    // The escalated retry is a different request, so it wears a different key: a deduping
    // provider must not answer it with the cached truncated response.
    expect(keys[0]).not.toBeNull()
    expect(keys[1]).not.toBeNull()
    expect(keys[1]).not.toBe(keys[0])
  })

  test("every truncated rung's bill rides the action, not only the winner's", async () => {
    let calls = 0
    const fetchImpl = (async () =>
      calls++ === 0
        ? cut("half an ans", { prompt_tokens: 10, completion_tokens: 32768, cost: 5 })
        : whole("the whole answer", { prompt_tokens: 10, completion_tokens: 4, cost: 1 })) as unknown as typeof fetch
    const layer = infer({
      provider: "openai",
      model: "m",
      baseUrl: "https://x",
      apiKey: "k",
      fetch: fetchImpl as never
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<Action>
    )
    expect(calls).toBe(2)
    expect(action).toMatchObject({
      kind: "complete",
      output: "the whole answer",
      usage: { promptTokens: 20, completionTokens: 32772, costUsd: 6, costSource: "provider" }
    })
  })

  test("the top rung still truncating fails the turn loudly, never half an answer", async () => {
    const fetchImpl = (async () => cut("half")) as unknown as typeof fetch
    const layer = infer({ provider: "openai", model: "m", baseUrl: "https://x", apiKey: "k", fetch: fetchImpl as never })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<{ kind: string; error?: string; failure?: { cause?: string } }>
    )
    expect(action.kind).toBe("fail")
    expect(action.error).toContain("output ceiling")
    // A cut answer is its own class: a bigger ceiling or a smaller task, never a repair and
    // never a refusal (tardie, src/events.ts, TURN_FAILURE_CAUSES).
    expect(action.failure?.cause).toBe("truncated")
  })

  test("wire-reported provenance beats the configured stamp", async () => {
    const routed = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          infer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "meta-llama/llama-3.1-70b",
            provider: "openrouter",
            fetch: (async () =>
              sse([
                { id: "r", provider: "DeepInfra", model: "meta-llama/llama-3.1-70b-instruct", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
                { id: "r", provider: "DeepInfra", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                usageChunk({ prompt_tokens: 10, completion_tokens: 4, cost: 0.002 })
              ])) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(routed.usage).toMatchObject({
      costUsd: 0.002,
      costSource: "provider",
      provider: "DeepInfra",
      model: "meta-llama/llama-3.1-70b-instruct"
    })
  })

  test("a mid-stream drop does not leak an unhandled rejection from the usage tee", async () => {
    const leaked: unknown[] = []
    const onLeak = (reason: unknown) => {
      leaked.push(reason)
    }
    process.on("unhandledRejection", onLeak)
    try {
      const fetchImpl = (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"},"index":0}]}\n\n'))
              controller.error(new Error("ECONNRESET mid-stream"))
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )) as unknown as typeof fetch
      const layer = infer({
        provider: "openai",
        model: "m",
        baseUrl: "https://x",
        apiKey: "k",
        fetch: fetchImpl as never,
        throttleRetryDelaysMs: [0],
        sleep: () => Promise.resolve()
      })
      const action = await Effect.runPromise(
        Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
          Effect.provide(layer)
        ) as Effect.Effect<Action>
      )
      expect(action).toMatchObject({
        kind: "fail",
        failure: { cause: "inference_attempts_exhausted", attempts: 2 }
      })
      await Promise.resolve()
      expect(leaked).toEqual([])
    } finally {
      process.off("unhandledRejection", onLeak)
    }
  })
})


describe("declared limits", () => {
  test("the ladder never exceeds the declared ceiling, and the ceiling is the last rung", () => {
    expect(ladderOf(undefined)).toEqual([32_768, 65_536])
    expect(ladderOf(64_000)).toEqual([32_768, 64_000])
    expect(ladderOf(200_000)).toEqual([32_768, 65_536, 200_000])
    expect(ladderOf(16_384)).toEqual([16_384])
  })

  test("the compatible leg states its ceiling and request timeout on the wire", async () => {
    let body: { max_tokens?: number } | undefined
    let timeout: unknown
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await request.text()) as { max_tokens?: number }
      timeout = (init as (RequestInit & { timeout?: number }) | undefined)?.timeout
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    }) as unknown as typeof fetch
    const layer = infer({
      provider: "openai",
      model: "m",
      baseUrl: "https://x",
      apiKey: "k",
      maxOutputTokens: 16_384,
      stream: { totalMs: 600_000 },
      fetch: fetchImpl as never
    })
    await Effect.runPromise(
      Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    expect(body?.max_tokens).toBe(16_384)
    expect(timeout).toBe(600_000)
  })
})
