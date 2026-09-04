import { describe, expect, test } from "bun:test"
import { Clock, Effect, Random } from "effect"
import { StopReason } from "@aws-sdk/client-bedrock-runtime"
import {
  codeMode,
  nativeOutput,
  output,
  outputFrom,
  outputRepairFor,
  renderOf,
  repairFallback,
  VALIDATE_ONCE_FALLBACK,
  NATIVE_MODE,
  type InferDelta
} from "tardie"

// reqOf wraps a trajectory in the render the actor would derive: the code surface half.
const surfaceRender = renderOf([codeMode(), nativeOutput], [])
const reqOf = (trajectory: ReadonlyArray<Event>) => ({
  trajectory,
  identity: { actor: "test", instance: "main", thread: "root", turn: "m1" },
  ...surfaceRender
})
import { Infer } from "tardie"
import {
  actionOf,
  DEFAULT_STREAM_BOUNDS,
  ladderOf,
  infer,
  retryAfterMsOf,
  throttleDelayMs,
  type ModelInferOptions
} from "./model"
import {
  bedrockConverseTextAdapter as bedrockAdapter,
  converseOutputConfig,
  converseStopClass,
  tapConverseUsage,
  tapStopReason,
  bedrockAdapter as registeredBedrockAdapter
} from "./bedrock"
import { anthropicAdapter } from "./anthropic"
import { openAICompatibleAdapter } from "./openai"
import { modelAdapters, type ModelAdapter } from "./adapter"
import type { ModelConfig } from "./model"
import type { ModelProtocol } from "./directory"
import {
  capabilityOf,
  outputModeOf,
  outputPreflight
} from "./output"
import type { Action } from "tardie/log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"

const testAdapters = modelAdapters(openAICompatibleAdapter, anthropicAdapter, registeredBedrockAdapter)
const testInfer = <const C extends Omit<ModelConfig, "protocol" | "provider" | "contextWindowTokens"> & { readonly protocol?: ModelProtocol }>(
  config: C,
  options: ModelInferOptions = {}
) => infer({ protocol: "openai-chat-completions", provider: "test", contextWindowTokens: 128_000, ...config }, testAdapters, options)

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
    expect(action).toMatchObject({ kind: "call", callId: "call_9", name: "execute", arguments: { code: "return 2" }, text: "let me check" })
  })

  test("plain text completes; nothing throws", () => {
    expect(actionOf({ content: "all done", toolCalls: [] } as never)).toEqual({ kind: "complete", output: "all done" })
    expect(() => actionOf({ content: "", toolCalls: [] } as never)).toThrow()
  })

  test("a final response completes and carries its text verbatim, JSON or prose", () => {
    // Nothing here judges a contract: the actor validates every completion before it records a
    // terminal (tardie, inference/machine.ts, completionOf).
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

const NATIVE_CAPABILITY = { guarantee: "native" as const, withTools: true }

const REPAIR = repairFallback({ attempts: 2 })

describe("the output mode one attempt runs in", () => {
  const contract = { kind: "contract" as const, contract: SCOUT }
  const withRepair = { ...contract, fallback: REPAIR, fallbackSystem: "reply with that JSON alone" }

  // A provider name is not evidence. Structured output belongs to the endpoint and the model
  // together, so a vendor string cannot let an unsupported model pass preflight and spend
  // (src/output/contract.ts, capabilityOf).
  test("no provider name grants a guarantee; only a declaration does", () => {
    expect(capabilityOf({})).toBeUndefined()
    expect(outputPreflight({ output: contract, tools: [] }, { provider: "openai", model: "gpt-3.5-turbo" }).join(" ")).toContain(
      "declares no structured output capability"
    )
    expect(outputPreflight({ output: contract, tools: [] }, { provider: "bedrock", model: "amazon.titan-text" }).join(" ")).toContain(
      "declares no structured output capability"
    )
    // Every reason names the endpoint and the model that could not serve it.
    const refused = outputPreflight({ output: contract, tools: [] }, { model: "mystery" }).join(" ")
    expect(refused).toContain("mystery")
    expect(refused).toContain("model-directory metadata")
  })

  // Native comes first whenever the endpoint can serve the call. A mounted fallback is a policy
  // for the calls it cannot serve, and it never turns the provider's own guarantee off.
  test("a declared native capability runs natively, mounted fallback or not", () => {
    const config = { provider: "openai", model: "gpt-5.2", output: NATIVE_CAPABILITY }
    expect(outputModeOf({ output: contract, tools: [] }, config)).toEqual({ mode: { kind: "native", name: "native" } })
    expect(outputModeOf({ output: withRepair, tools: [] }, config)).toEqual({ mode: { kind: "native", name: "native" } })
  })

  test("no native capability runs the declared fallback, and fails without one", () => {
    const config = { model: "m" }
    expect(outputModeOf({ output: withRepair, tools: [] }, config)).toEqual({ mode: REPAIR })
    const validateOnce = { ...contract, fallback: VALIDATE_ONCE_FALLBACK }
    expect(outputModeOf({ output: validateOnce, tools: [] }, config)).toEqual({ mode: VALIDATE_ONCE_FALLBACK })
    const selected = outputModeOf({ output: contract, tools: [] }, config)
    expect("errors" in selected && selected.errors.join(" ")).toContain("declares no structured output capability")
    const declaredNone = outputModeOf({ output: contract, tools: [] }, { model: "m", output: { guarantee: "none" } })
    expect("errors" in declaredNone && declaredNone.errors.join(" ")).toContain("declares no native structured output")
  })

  // A native endpoint that cannot carry a schema beside tools makes native unavailable for this
  // call alone, so the declared fallback runs and nothing buys a second inference.
  test("a tool list an endpoint cannot combine makes native unavailable for the call", () => {
    const config = { provider: "narrow", model: "m", output: { guarantee: "native" as const, withTools: false } }
    expect(outputModeOf({ output: contract, tools: [] }, config)).toEqual({ mode: { kind: "native", name: "native" } })
    expect(outputModeOf({ output: withRepair, tools: [{}] }, config)).toEqual({ mode: REPAIR })
    const selected = outputModeOf({ output: contract, tools: [{}] }, config)
    expect("errors" in selected && selected.errors.join(" ")).toContain("cannot carry the contract")
    expect("errors" in selected && selected.errors.join(" ")).toContain("mounts no output fallback")
  })

  test("a declaration that is not a contract fails before spend, whatever the endpoint promised", () => {
    const loose = outputFrom("loose", { type: "object", properties: { a: { type: "string" } }, required: [] })
    expect("errors" in loose).toBe(true)
    const invalid = { kind: "invalid" as const, errors: ["message m1: /: bad"] }
    expect(
      outputPreflight({ output: invalid, tools: [] }, { model: "m", output: NATIVE_CAPABILITY }).join(" ")
    ).toContain("is not a contract")
  })
})

describe("the Converse output surface", () => {
  const request = { kind: "contract" as const, contract: SCOUT }

  test("the contract maps onto outputConfig.textFormat, with the schema as a JSON string", () => {
    expect(converseOutputConfig(request, NATIVE_MODE)).toEqual({
      textFormat: {
        type: "json_schema",
        structure: { jsonSchema: { name: "scout", schema: JSON.stringify(SCOUT.schema) } }
      }
    })
  })

  test("buildInput sets the native surface, and never a forced tool", () => {
    const config = { baseUrl: "https://bedrock.test/us-east-1", apiKey: "k", model: "anthropic.claude-sonnet", protocol: "bedrock-converse" as const, provider: "bedrock", contextWindowTokens: 128_000 }
    const options = { model: config.model, messages: [{ role: "user", content: "go" }], systemPrompts: ["be brief"], tools: [] }
    const withContract = bedrockAdapter(config, 4096, DEFAULT_STREAM_BOUNDS, request, NATIVE_MODE).buildInput(options as never)
    expect(withContract.outputConfig).toEqual(converseOutputConfig(request, NATIVE_MODE)!)
    expect(JSON.stringify(withContract.toolConfig ?? {})).not.toContain("scout")
    expect(withContract.inferenceConfig).toMatchObject({ maxTokens: 4096 })
    // No contract, no output surface at all.
    expect(bedrockAdapter(config, 4096, DEFAULT_STREAM_BOUNDS).buildInput(options as never).outputConfig).toBeUndefined()
    // A fallback mode sends no schema on the wire, whatever the contract says.
    expect(
      bedrockAdapter(config, 4096, DEFAULT_STREAM_BOUNDS, request, REPAIR).buildInput(options as never).outputConfig
    ).toBeUndefined()
  })

  // The adapter's own processor folds several stop reasons into "stop" before the shared
  // processor sees them, so the raw reason is tapped off the SDK stream and read here. The cases
  // are the SDK's own enum, so a reason AWS adds breaks this test rather than passing silently
  // (@aws-sdk/client-bedrock-runtime, StopReason).
  test("every Converse stop reason has a class, and the classes are the failure classes", () => {
    expect(Object.values(StopReason).map((reason) => [reason, converseStopClass(reason)])).toEqual([
      ["content_filtered", "refused"],
      ["end_turn", "ok"],
      ["guardrail_intervened", "refused"],
      ["malformed_model_output", "violation"],
      ["malformed_tool_use", "ok"],
      ["max_tokens", "truncated"],
      ["model_context_window_exceeded", "truncated"],
      ["stop_sequence", "ok"],
      ["tool_use", "ok"]
    ])
    expect(converseStopClass(undefined)).toBe("ok")
  })

  test("the stop tap keeps the raw reason the processor folds away", async () => {
    const stops: { stopReason?: string } = {}
    const events = {
      async *[Symbol.asyncIterator]() {
        yield { messageStart: { role: "assistant" } }
        yield { messageStop: { stopReason: "guardrail_intervened" } }
      }
    }
    const seen: Array<unknown> = []
    for await (const event of tapStopReason(events, stops)) seen.push(event)
    expect(seen).toHaveLength(2)
    expect(stops.stopReason).toBe("guardrail_intervened")
  })

  test("the Converse usage tap keeps the raw provider metrics", async () => {
    const metrics = {
      inputTokens: 40,
      outputTokens: 8,
      totalTokens: 48,
      cacheReadInputTokens: 24,
      cacheWriteInputTokens: 4
    }
    const reported: { usage?: unknown } = {}
    const events = {
      async *[Symbol.asyncIterator]() {
        yield { messageStart: { role: "assistant" } }
        yield { metadata: { usage: metrics } }
      }
    }
    const seen: Array<unknown> = []
    for await (const event of tapConverseUsage(events, reported)) seen.push(event)
    expect(seen).toHaveLength(2)
    expect(reported.usage).toEqual(metrics)
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
    const layer = testInfer({
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
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", fetch: fetchImpl })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "2+2?", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(action).toMatchObject({ kind: "complete", output: "the answer is 4" })
  })

  const ANSWER = JSON.stringify({ aspects: [{ name: "a", description: "b" }] })

  type Sent = {
    tools?: ReadonlyArray<{ function?: { name?: string } }>
    tool_choice?: unknown
    messages?: ReadonlyArray<{ role: string; content?: string }>
    response_format?: { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } }
  }

  const wire = async (options: {
    readonly fallback?: ReturnType<typeof outputRepairFor>
    readonly capability?: { readonly guarantee: "native"; readonly withTools: boolean }
  }) => {
    let body: Sent | null = null
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await request.text())
      return sse([
        { id: "r3", choices: [{ index: 0, delta: { role: "assistant", content: ANSWER } }] },
        { id: "r3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])
    }) as typeof globalThis.fetch
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "gpt-5.2",
      provider: "openai",
      ...(options.capability === undefined ? {} : { output: options.capability }),
      fetch: fetchImpl
    })
    const render = renderOf(
      options.fallback === undefined ? [codeMode(), nativeOutput] : [codeMode(), options.fallback],
      declared()
    )
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react({
        trajectory: declared(),
        identity: { actor: "test", instance: "main", thread: "root", turn: "m1" },
        ...render
      })).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )) as Action
    return { action, sent: body! }
  }

  test("a declared contract rides response_format strictly, beside the tools and with no answer tool", async () => {
    const { action, sent } = await wire({ capability: NATIVE_CAPABILITY })
    // The structured response is the completion, decoded from the content the schema constrained.
    expect(action).toMatchObject({ kind: "complete", output: ANSWER })
    // The mode is reported on the action, so the reactor records a fact rather than a guess.
    expect(action.mode).toEqual({ kind: "native", name: "native" })
    expect(sent.response_format).toMatchObject({ type: "json_schema" })
    // The declared identity rides the wire, not the adapter's fixed one.
    expect(sent.response_format?.json_schema).toMatchObject({ name: "scout", strict: true })
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

  // Native is preferred whenever the endpoint can serve the call, so a mounted fallback changes
  // neither the transport nor a single word of the request (src/output/contract.ts, outputModeOf).
  test("a mounted fallback is dormant on a native endpoint", async () => {
    const bare = await wire({ capability: NATIVE_CAPABILITY })
    const mounted = await wire({ capability: NATIVE_CAPABILITY, fallback: outputRepairFor({ attempts: 2 }) })
    expect(mounted.action.mode).toEqual({ kind: "native", name: "native" })
    expect(mounted.sent.response_format).toEqual(bare.sent.response_format as never)
    expect(mounted.sent.messages).toEqual(bare.sent.messages as never)
    expect(JSON.stringify(mounted.sent.messages)).not.toContain("Reply with that JSON alone")
  })

  test("the same fallback runs, and sends its instruction, on an endpoint with no guarantee", async () => {
    const { action, sent } = await wire({ fallback: outputRepairFor({ attempts: 2 }) })
    expect(action.mode).toEqual({ kind: "repair", name: "repair", attempts: 2, projectHistory: true })
    // No guarantee was claimed, so no schema was sent.
    expect(sent.response_format).toBeUndefined()
    // The fallback's own instruction is what asks for the shape.
    const system = sent.messages?.filter((m) => m.role === "system").map((m) => m.content).join("\n") ?? ""
    expect(system).toContain('conforming to the schema "scout"')
  })

  test("an implementation that asks for no guarantee sends no response_format at all", async () => {
    const { sent } = await wire({ fallback: outputRepairFor() })
    expect(sent.response_format).toBeUndefined()
  })

  test("an unsupported contract fails before the fetch, so nothing is spent", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return sse([])
    }) as unknown as typeof globalThis.fetch
    // No provider name and no declared capability: the endpoint promises nothing.
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "mystery", fetch: fetchImpl })
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

  // A structured-output refusal arrives as a `refusal` delta under an ordinary stop, which the
  // adapter's processor keeps nowhere: an unread one reads as "the model said nothing" and enters
  // the transport failure path (https://developers.openai.com/api/docs/guides/structured-outputs).
  test("a refusal on the wire is its own failure class, keeps its bill, and the ladder does not climb it", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return sse([
        { id: "r5", choices: [{ index: 0, delta: { role: "assistant" } }] },
        { id: "r5", choices: [{ index: 0, delta: { refusal: "I cannot " } }] },
        { id: "r5", choices: [{ index: 0, delta: { refusal: "help with that." } }] },
        { id: "r5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 0 } }
      ])
    }) as unknown as typeof globalThis.fetch
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "m",
      provider: "openai",
      output: NATIVE_CAPABILITY,
      fetch: fetchImpl,
      sleep: async () => {}
    })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(declared()))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect(calls).toBe(1)
    expect((action as { failure?: { cause?: string } }).failure).toMatchObject({ cause: "refused" })
    // The whole refusal is reported, assembled from its deltas.
    expect((action as { error?: string }).error).toContain("I cannot help with that.")
    // A refusal still spent the prompt, so the turn records what it cost, and who served it.
    expect(action.usage).toMatchObject({ promptTokens: 11 })
    expect(action.endpoint).toMatchObject({ provider: "openai", model: "m" })
    expect(action.mode).toEqual({ kind: "native", name: "native" })
  })

  test("a content filter with no text is the same class", async () => {
    const fetchImpl = (async () =>
      sse([
        { id: "r6", choices: [{ index: 0, delta: { role: "assistant" } }] },
        { id: "r6", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }
      ])) as unknown as typeof globalThis.fetch
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", fetch: fetchImpl, sleep: async () => {} })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) =>
        model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))
      ).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect((action as { failure?: { cause?: string } }).failure).toMatchObject({ cause: "refused" })
  })

  // Provenance is not a by-product of billing. An endpoint that reports no tokens still has to be
  // named in the log, or a replay cannot say which model supplied a native guarantee
  // (tardie, src/events.ts, Endpoint).
  test("the endpoint is recorded even when the wire reports no usage at all", async () => {
    const fetchImpl = (async () =>
      sse([
        { id: "r7", choices: [{ index: 0, delta: { role: "assistant", content: ANSWER } }] },
        { id: "r7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])) as unknown as typeof globalThis.fetch
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "gpt-5.2",
      provider: "openai",
      output: NATIVE_CAPABILITY,
      fetch: fetchImpl
    })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf(declared()))).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect(action.usage).toBeUndefined()
    expect(action.endpoint).toEqual({ provider: "openai", model: "gpt-5.2" })
  })

  test("a router that names its upstream records both the configured pair and the routed one", async () => {
    const fetchImpl = (async () =>
      sse([
        { id: "r8", provider: "Anthropic", model: "claude-sonnet-4.5", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
        { id: "r8", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ])) as unknown as typeof globalThis.fetch
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "auto", provider: "openrouter", fetch: fetchImpl })
    const action = (await Effect.runPromise(
      Effect.flatMap(Infer, (model) =>
        model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))
      ).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )) as Action
    expect(action.endpoint).toEqual({
      provider: "openrouter",
      model: "auto",
      routedProvider: "Anthropic",
      routedModel: "claude-sonnet-4.5"
    })
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
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", fetch: fetchImpl })
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

describe("ephemeral inference deltas", () => {
  test("observes normalized text without changing the terminal action", async () => {
    const deltas: InferDelta[] = []
    const fetchImpl = (async () => sse([
      { id: "stream-1", choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] },
      { id: "stream-1", choices: [{ index: 0, delta: { content: "lo" } }] },
      { id: "stream-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ])) as unknown as typeof globalThis.fetch
    const layer = testInfer(
      { baseUrl: "https://model.test/v1", apiKey: "k", model: "gpt-test", provider: "openai", fetch: fetchImpl },
      {
        observer: { onDelta: (delta) => Effect.sync(() => { deltas.push(delta) }) },
        physicalAttemptId: () => "physical-1"
      }
    )
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([
        { type: "MessageReceived", id: "m1", text: "go", at: 1 }
      ]), "m1/infer/0")).pipe(Effect.provide(layer)) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({ kind: "complete", output: "hello" })
    expect(deltas).toEqual([
      {
        actor: "test",
        instance: "main",
        thread: "root",
        turn: "m1",
        logicalAttempt: "m1/infer/0",
        physicalAttempt: "physical-1",
        model: { provider: "openai", model_id: "gpt-test" },
        blockIndex: 0,
        sequence: 0,
        text: "hel"
      },
      {
        actor: "test",
        instance: "main",
        thread: "root",
        turn: "m1",
        logicalAttempt: "m1/infer/0",
        physicalAttempt: "physical-1",
        model: { provider: "openai", model_id: "gpt-test" },
        blockIndex: 0,
        sequence: 1,
        text: "lo"
      }
    ])
  })

  test("a retried Bedrock attempt keeps the logical identity and changes the physical identity", async () => {
    let starts = 0
    let physical = 0
    const deltas: InferDelta[] = []
    const adapter: ModelAdapter = {
      id: "test/bedrock",
      protocols: ["bedrock-converse"],
      start: () => {
        const current = starts++
        return {
          stream: {
            async *[Symbol.asyncIterator]() {
              yield { type: "TEXT_MESSAGE_START", messageId: `b${current}`, role: "assistant", timestamp: 1 } as never
              yield {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: `b${current}`,
                delta: current === 0 ? "discarded" : "winner",
                timestamp: 2
              } as never
              if (current === 0) throw Object.assign(new Error("429 from Bedrock"), { status: 429 })
              yield { type: "TEXT_MESSAGE_END", messageId: `b${current}`, timestamp: 3 } as never
            }
          }
        }
      }
    }
    const layer = infer({
      baseUrl: "https://bedrock.test/us-east-1",
      apiKey: "k",
      model: "anthropic.claude-test",
      protocol: "bedrock-converse",
      provider: "bedrock",
      contextWindowTokens: 128_000,
      throttleRetryDelaysMs: [1],
      sleep: async () => {}
    }, modelAdapters(adapter), {
      observer: { onDelta: (delta) => Effect.sync(() => { deltas.push(delta) }) },
      physicalAttemptId: () => `physical-${physical++}`
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([
        { type: "MessageReceived", id: "m1", text: "go", at: 1 }
      ]), "m1/infer/0")).pipe(Effect.provide(layer)) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({ kind: "complete", output: "winner" })
    expect(deltas.map(({ logicalAttempt, physicalAttempt, text }) => ({ logicalAttempt, physicalAttempt, text }))).toEqual([
      { logicalAttempt: "m1/infer/0", physicalAttempt: "physical-0", text: "discarded" },
      { logicalAttempt: "m1/infer/0", physicalAttempt: "physical-1", text: "winner" }
    ])
  })

  test("observer failure and saturation leave inference unchanged", async () => {
    let deliveries = 0
    const fetchImpl = (async () => sse([
      ...Array.from({ length: 10 }, (_, index) => ({
        id: "stream-2",
        choices: [{ index: 0, delta: { content: String(index) } }]
      })),
      { id: "stream-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ])) as unknown as typeof globalThis.fetch
    const layer = testInfer(
      { baseUrl: "https://model.test/v1", apiKey: "k", model: "gpt-test", provider: "openai", fetch: fetchImpl },
      {
        observer: {
          policy: { bufferCapacity: 1, deliveryTimeoutMs: 1 },
          onDelta: () => deliveries++ === 0 ? Effect.die(new Error("observer offline")) : Effect.never
        },
        physicalAttemptId: () => "physical-saturated"
      }
    )
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([
        { type: "MessageReceived", id: "m1", text: "go", at: 1 }
      ]), "m1/infer/0")).pipe(Effect.provide(layer)) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({ kind: "complete", output: "0123456789" })
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
    const rawUsage = {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0
    }
    const billed = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          testInfer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            provider: "openai",
            pricing: { ...table, cachedPromptUsdPerToken: 0.0001 },
            fetch: (async () =>
              sse([{ ...okText[0], usage: null }, okText[1], usageChunk(rawUsage)])) as unknown as typeof globalThis.fetch
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
        totalTokens: 14,
        cachedPromptTokens: 4,
        reasoningTokens: 2,
        costUsd: 0,
        costSource: "provider",
        reportedCostUsd: 0,
        estimatedCostUsd: 6 * 0.001 + 4 * 0.0001 + 4 * 0.002,
        provider: "openai",
        model: "test-model",
        providerReports: [{ provider: "openai", model: "test-model", providerSpecific: rawUsage }]
      }
    })

    const filled = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          testInfer({
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
      estimatedCostUsd: 10 * 0.001 + 4 * 0.002,
      provider: "openai",
      model: "test-model",
      providerReports: [
        {
          provider: "openai",
          model: "test-model",
          providerSpecific: { prompt_tokens: 10, completion_tokens: 4 }
        }
      ]
    })

    const unknown = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(
          testInfer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            fetch: (async () => sse(okText)) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(unknown).toMatchObject({ kind: "complete", output: "ok" })
  })

  test("multiple wire usage objects remain one lossless physical report", async () => {
    const detailed = {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 }
    }
    const billed = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0 }
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) =>
        model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))
      ).pipe(
        Effect.provide(
          testInfer({
            baseUrl: "https://model.test/v1",
            apiKey: "k",
            model: "test-model",
            provider: "openai",
            pricing: { ...table, cachedPromptUsdPerToken: 0.0001 },
            fetch: (async () =>
              sse([...okText, usageChunk(detailed), usageChunk(billed)])) as unknown as typeof globalThis.fetch
          })
        )
      ) as Effect.Effect<Action>
    )
    expect(action.usage).toMatchObject({
      cachedPromptTokens: 4,
      reasoningTokens: 2,
      reportedCostUsd: 0,
      estimatedCostUsd: 6 * 0.001 + 4 * 0.0001 + 4 * 0.002,
      providerReports: [{ provider: "openai", model: "test-model", providerSpecific: [detailed, billed] }]
    })
  })
})

// A transient failure (429, 5xx, a connection error, or a stream timeout) retries inside the one act. Exhaustion
// returns a failed action that the agent records as a resumable terminal. `sleep` is the test seam
// that swaps the real backoff wait for an instant one, so these run in milliseconds.
describe("infer: transient retry", () => {
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
    const seed = "throttle retry"
    const expectedDelay = Effect.runSync(Random.next.pipe(Random.withSeed(seed))) * 2_000
    const layer = testInfer({
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
        Effect.provide(layer),
        Random.withSeed(seed)
      ) as Effect.Effect<unknown>
    )
    expect(action).toMatchObject({ kind: "complete", output: "ok" })
    expect(calls).toBe(2)
    expect(slept).toEqual([expectedDelay])
  })

  test("a retry reads the supplied Clock", async () => {
    const now = 1_000_000
    let clockReads = 0
    const liveClock = Effect.runSync(Clock.Clock)
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => {
        clockReads += 1
        return now
      },
      currentTimeMillis: Effect.succeed(now),
      currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
      currentTimeNanos: liveClock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: liveClock.monotonicTimeNanos,
      sleep: (duration) => liveClock.sleep(duration)
    }
    let calls = 0
    const slept: Array<number> = []
    const seed = "clock retry"
    const expectedDelay = Effect.runSync(Random.next.pipe(Random.withSeed(seed))) * 2_000
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: (async () => {
        calls += 1
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429
          })
        }
        return okStream()
      }) as unknown as typeof globalThis.fetch,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer),
        Effect.provideService(Clock.Clock, clock),
        Random.withSeed(seed)
      ) as Effect.Effect<unknown>
    )
    expect(action).toMatchObject({ kind: "complete", output: "ok" })
    expect(clockReads).toBe(1)
    expect(slept).toEqual([expectedDelay])
  })

  test("retries exhaust after the bounded set and report the effective policy", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: "upstream trouble" } }), { status: 503 })
    }) as unknown as typeof globalThis.fetch
    const slept: Array<number> = []
    const layer = testInfer({
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
          retryAfterJitterMs: 1_000,
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
    const layer = testInfer({
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
    const layer = testInfer({
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

  test("a flattened connection error enters the bounded retry policy", async () => {
    let calls = 0
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      fetch: (() => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error("socket closed")) : Promise.resolve(okStream())
      }) as unknown as typeof globalThis.fetch,
      throttleRetryDelaysMs: [0],
      sleep: () => Promise.resolve()
    })

    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<Action>
    )
    expect(action).toMatchObject({ kind: "complete", output: "ok" })
    expect(calls).toBe(2)
  })
})

describe("retry-after", () => {
  const NOW = 1_000_000
  const nextRandom = () => 0.5

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
    const stated = throttleDelayMs({ headers: { "retry-after": "7" } }, 0, NOW, nextRandom)
    expect(stated).toBe(7_500)
    expect(throttleDelayMs({ headers: { "retry-after": "300" } }, 0, NOW, nextRandom)).toBeUndefined()
  })

  test("no stated wait falls back to the ladder, and the ladder still bounds retries", () => {
    const fallback = throttleDelayMs({}, 1, NOW, nextRandom)
    expect(fallback).toBe(4_000)
    expect(throttleDelayMs({ headers: { "retry-after": "1" } }, 3, NOW, nextRandom)).toBeUndefined()
  })

  test("a caller-supplied ladder sets the retry count and the Retry-After ceiling", () => {
    const short = [100]
    expect(throttleDelayMs({}, 0, NOW, nextRandom, short)).toBe(50)
    expect(throttleDelayMs({}, 1, NOW, nextRandom, short)).toBeUndefined()
    expect(throttleDelayMs({ headers: { "retry-after": "1" } }, 0, NOW, nextRandom, short)).toBeUndefined()
  })

  test("a caller-supplied Retry-After jitter changes the stated wait", () => {
    expect(throttleDelayMs({ headers: { "retry-after": "1" } }, 0, NOW, nextRandom, [2_000], 200)).toBe(1_100)
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
    const layer = testInfer({ provider: "openai", model: "m", baseUrl: "https://x", apiKey: "k", fetch: fetchImpl as never })
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
    const layer = testInfer({
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
      usage: {
        promptTokens: 20,
        completionTokens: 32772,
        costUsd: 6,
        costSource: "provider",
        reportedCostUsd: 6,
        providerReports: [
          {
            provider: "openai",
            model: "m",
            providerSpecific: { prompt_tokens: 10, completion_tokens: 32768, cost: 5 }
          },
          {
            provider: "openai",
            model: "m",
            providerSpecific: { prompt_tokens: 10, completion_tokens: 4, cost: 1 }
          }
        ]
      }
    })
  })

  test("the top rung still truncating fails the turn loudly, never half an answer", async () => {
    const fetchImpl = (async () => cut("half")) as unknown as typeof fetch
    const layer = testInfer({ provider: "openai", model: "m", baseUrl: "https://x", apiKey: "k", fetch: fetchImpl as never })
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
          testInfer({
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
      const layer = testInfer({
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
  test("the binding resolves only its exact model reference", async () => {
    const layer = testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m" })
    const resolved = await Effect.runPromise(
      Effect.flatMap(Infer, (binding) => Effect.sync(() => binding.resolve!({ provider: "test", model_id: "m" }))).pipe(Effect.provide(layer))
    )
    expect(resolved).toMatchObject({ model: { provider: "test", model_id: "m" }, contextWindowTokens: 128_000 })
    await expect(Effect.runPromise(
      Effect.flatMap(Infer, (binding) => Effect.sync(() => binding.resolve!({ provider: "test", model_id: "other" }))).pipe(Effect.provide(layer))
    )).rejects.toThrow("this host binds test/m")
  })

  test("the ladder never exceeds the declared ceiling, and the ceiling is the last rung", () => {
    expect(ladderOf(undefined)).toEqual([32_768, 65_536])
    expect(ladderOf(64_000)).toEqual([32_768, 64_000])
    expect(ladderOf(200_000)).toEqual([32_768, 65_536, 200_000])
    expect(ladderOf(16_384)).toEqual([16_384])
  })

  test("the compatible leg states its ceiling and disables Bun's fetch timeout", async () => {
    let body: { max_tokens?: number } | undefined
    let timeout: unknown
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      body = JSON.parse(await request.text()) as { max_tokens?: number }
      timeout = (init as (RequestInit & { timeout?: boolean }) | undefined)?.timeout
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    }) as unknown as typeof fetch
    const layer = testInfer({
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
    expect(timeout).toBe(false)
  })
})

describe("stream bounds", () => {
  test("an expired bound aborts the underlying request", async () => {
    let requestSignal: AbortSignal | undefined
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => controller.error(new DOMException("aborted", "AbortError"))
            if (requestSignal?.aborted === true) abort()
            else requestSignal?.addEventListener("abort", abort, { once: true })
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    }) as unknown as typeof fetch
    const layer = testInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "m",
      stream: { firstChunkMs: 20, idleMs: 20, totalMs: 100 },
      throttleRetryDelaysMs: [],
      fetch: fetchImpl as never
    })

    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (i) => i.react(reqOf([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]))).pipe(Effect.provide(layer)) as Effect.Effect<Action>
    )

    expect(action.kind).toBe("fail")
    expect(requestSignal?.aborted).toBe(true)
  })

  test("an invalid bound refuses at construction", () => {
    // A value outside Bun's timer range would clamp to 1ms and read as provider trouble
    // (model.ts, infer).
    expect(() =>
      testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", stream: { totalMs: Infinity } })
    ).toThrow(/finite positive/)
    expect(() =>
      testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", stream: { idleMs: 0 } })
    ).toThrow(/finite positive/)
    expect(() =>
      testInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "m", stream: { firstChunkMs: 2_147_483_648 } })
    ).toThrow(/2147483647/)
  })
})
