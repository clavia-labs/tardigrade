import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import type { ModelRequest, NativeTool } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { inference } from "../modules/inference"
import { nativeTools } from "../modules/native-tools"
import { vercelGatewayInference } from "./vercel-gateway"

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const asRecords = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item)
        return record === undefined ? [] : [record]
      })
    : []

const request: ModelRequest = {
  system: "You are a support agent.",
  messages: [
    { role: "user", content: "Find order 4182." },
    { role: "system", content: "Cite the invoice id." }
  ],
  tools: [
    {
      name: "lookup_invoice",
      description: "Look up one invoice.",
      inputSchema: { type: "object" }
    }
  ]
}

const provider = (stub: typeof fetch, options: Record<string, unknown> = {}) =>
  vercelGatewayInference({
    apiKey: "vercel-key",
    model: "anthropic/claude-opus-5",
    contextWindow: 200_000,
    fetch: stub,
    ...options
  })

const replied = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe("an Anthropic model on the Vercel gateway", () => {
  // The surface is chosen by the model rather than by the caller, because the caller can not be
  // expected to know which of a gateway's surfaces carries a given model's thinking state.
  test("is asked on the Messages surface, in the shape that API defines", async () => {
    const calls: Array<{ readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>
      })
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Invoice INV-4182." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 8, output_tokens: 3 }
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    expect(await Effect.runPromise(provider(stub).react(request, "turn/infer/0"))).toEqual({
      kind: "complete",
      output: "Invoice INV-4182.",
      usage: { promptTokens: 8, completionTokens: 3 }
    })
    expect(calls[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/messages")
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("turn/infer/0")
    expect(calls[0]?.body).toMatchObject({
      model: "anthropic/claude-opus-5",
      system: "You are a support agent.",
      tools: [
        { name: "lookup_invoice", description: "Look up one invoice.", input_schema: { type: "object" } }
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true }
    })
    // This API requires a ceiling, so one is always sent.
    expect(typeof calls[0]?.body.max_tokens).toBe("number")
  })

  // Roles alternate on this API, and the renderer emits a nudge as a message of its own beside the
  // user turn it belongs to. Sending both as they came would be rejected.
  test("joins the neighbouring messages that share a role", async () => {
    const calls: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await Effect.runPromise(provider(stub).react(request, "k"))

    const messages = asRecords(calls[0]?.messages)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe("user")
    expect(asRecords(messages[0]?.content).map((block) => block.text)).toEqual([
      "Find order 4182.",
      "Cite the invoice id."
    ])
  })

  // Where a request runs is a deployment's decision. This framework states no preference, so a
  // caller who names none gets the gateway's own routing.
  test("pins a route only when the caller names one", async () => {
    const calls: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await Effect.runPromise(provider(stub).react(request, "k"))
    await Effect.runPromise(
      provider(stub, { routes: ["anthropic", "vertex"] }).react(request, "k")
    )

    expect(calls[0]).not.toHaveProperty("providerOptions")
    expect(calls[1]?.providerOptions).toEqual({ gateway: { only: ["anthropic", "vertex"] } })
  })

  // A route that answers with several calls at once is a real deployment, and the harness runs one
  // call at a time. The failure says which setting was asked for and which option reaches a route
  // that honours it, because this framework does not choose the route.
  test("names the routes option when a route ignores the request for serial calls", async () => {
    const action = await Effect.runPromise(
      provider(
        replied({
          content: [
            { type: "tool_use", id: "c-1", name: "lookup_invoice", input: {} },
            { type: "tool_use", id: "c-2", name: "lookup_invoice", input: {} }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 4 }
        })
      ).react(request, "k")
    )

    const reason = String(action.kind === "fail" ? action.error : "")
    expect(reason).toContain("routes")
    expect(reason).toContain("Bedrock")
  })

  test("asks for the thinking effort a caller states", async () => {
    const calls: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await Effect.runPromise(provider(stub, { effort: "high" }).react(request, "k"))
    await Effect.runPromise(provider(stub).react(request, "k"))

    expect(calls[0]?.output_config).toEqual({ effort: "high" })
    // Absent leaves the model's own default, which already thinks on the current models.
    expect(calls[1]).not.toHaveProperty("output_config")
  })

  // The ceiling belongs to the model, and the catalog publishes it. Holding every model to the one
  // figure that is safe for all of them would cut a long answer short on the models that could have
  // finished it, and nothing in the reply would say the ceiling was this side's choice.
  test("takes the output ceiling the catalog publishes for the model", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "anthropic/claude-opus-5", context_window: 1_000_000, max_tokens: 128_000 }
            ]
          }),
          { status: 200 }
        )
      }
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const built = await Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "anthropic/claude-opus-5",
        baseUrl: "https://anthropic-catalog.invalid/v1",
        fetch: stub
      })
    )
    await Effect.runPromise(built.react(request, "k"))

    expect(bodies[0]?.max_tokens).toBe(128_000)
  })

  // A caller who states the window has said they know the model's limits, and this call asks the
  // gateway nothing. What is left is a ceiling current Claude models accept. An older model that
  // refuses that figure takes `maxOutputTokens` set to what it accepts.
  test("falls back to a ceiling current models accept, and takes the caller's over it", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    await Effect.runPromise(provider(stub).react(request, "k"))
    await Effect.runPromise(provider(stub, { maxOutputTokens: 32_000 }).react(request, "k"))

    expect(bodies[0]?.max_tokens).toBe(64_000)
    expect(bodies[1]?.max_tokens).toBe(32_000)
  })

  // This API takes a call's input as a value rather than as the string the other format uses. A
  // recorded string that will not parse is a broken record, and calling the tool with an empty
  // input in its place would answer a question the model never asked.
  test("refuses to replay a tool call whose recorded arguments are not JSON", async () => {
    let called = false
    const stub = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const action = await Effect.runPromise(
      provider(stub).react(
        {
          ...request,
          messages: [
            { role: "user", content: "Find order 4182." },
            {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "c-1", name: "lookup_invoice", arguments: '{"orderId":"41' }]
            },
            { role: "tool", toolCallId: "c-1", content: "{}" }
          ]
        },
        "k"
      )
    )

    expect(action.kind).toBe("fail")
    expect(String(action.kind === "fail" ? action.error : "")).toContain("lookup_invoice")
    expect(String(action.kind === "fail" ? action.error : "")).toContain("not JSON")
    expect(called).toBe(false)
  })

  // A conversation ending on an assistant turn asks this API to continue it, which is how a turn
  // resumes from a fragment. The API refuses one ending in whitespace, and a fragment cut
  // mid-sentence is exactly the message that ends that way.
  test("trims a trailing assistant turn so a fragment can be continued", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      provider(stub).react(
        {
          system: "",
          tools: [],
          messages: [
            { role: "user", content: "Write the addendum." },
            { role: "assistant", content: "The lease was signed on " }
          ]
        },
        "k"
      )
    )

    expect(asRecords(bodies[0]?.messages)[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "The lease was signed on" }]
    })
  })

  // Whitespace was the whole of it, so there is no assistant turn left to send. Dropping it asks
  // the model for the answer rather than sending a message this API would refuse.
  test("drops a trailing assistant turn that was only whitespace", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      })
    }) as unknown as typeof fetch

    await Effect.runPromise(
      provider(stub).react(
        {
          system: "",
          tools: [],
          messages: [
            { role: "user", content: "Write the addendum." },
            { role: "assistant", content: "   " }
          ]
        },
        "k"
      )
    )

    expect(asRecords(bodies[0]?.messages)).toHaveLength(1)
  })

  test("records an answer stopped at the output-token limit", async () => {
    const action = await Effect.runPromise(
      provider(
        replied({
          content: [{ type: "text", text: "The lease was signed on 29 August and the" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 900, output_tokens: 8192 }
        })
      ).react(request, "k")
    )

    expect(action).toEqual({
      kind: "truncated",
      text: "The lease was signed on 29 August and the",
      usage: { promptTokens: 900, completionTokens: 8192 }
    })
  })

  test("refuses multiple tool calls instead of dropping all but the first", async () => {
    const action = await Effect.runPromise(
      provider(
        replied({
          content: [
            { type: "tool_use", id: "c-1", name: "lookup_invoice", input: {} },
            { type: "tool_use", id: "c-2", name: "lookup_invoice", input: {} }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 4 }
        })
      ).react(request, "k")
    )

    expect(action.kind).toBe("fail")
    expect(String(action.kind === "fail" ? action.error : "")).toContain("multiple tool calls")
  })

  // A cached read is a read of the same conversation, so a turn served from cache reports the
  // context it actually carried rather than the part that missed.
  test("counts what the model read, cached or not", async () => {
    const action = await Effect.runPromise(
      provider(
        replied({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 100
          }
        })
      ).react(request, "k")
    )

    expect(action.usage).toEqual({ promptTokens: 512, completionTokens: 5 })
  })
})

const tool: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice.",
    inputSchema: { type: "object" }
  },
  run: () => Effect.succeed({ invoice: "INV-4182" })
}

describe("thinking state on the Messages surface", () => {
  // Claude returns its thinking as signed blocks. A harness that rebuilds the conversation from its
  // own log drops them, and the model then answers the rest of the turn without the reasoning it
  // already paid for. This follows the whole Flamework path, because a provider-only test would miss
  // the event that failed to carry the blocks.
  test("round-trips signed thinking blocks through tools and later turns", async () => {
    const thinking = {
      type: "thinking",
      thinking: "The invoice id is INV-4182.",
      signature: "signed-by-anthropic"
    }
    const finalThinking = { type: "thinking", thinking: "Answering now.", signature: "second" }
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            content: [
              thinking,
              { type: "text", text: "I will look it up." },
              { type: "tool_use", id: "call-1", name: "lookup_invoice", input: {} }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 20, output_tokens: 30 }
          }),
          { status: 200 }
        )
      }
      if (bodies.length === 2) {
        // The assistant turn has to carry the thinking block back, ahead of the text and the call
        // it belongs to, or the model continues without it.
        const assistant = asRecords(body.messages).find((message) => message.role === "assistant")
        const blocks = asRecords(assistant?.content)
        if (blocks[0]?.type !== "thinking" || blocks[0]?.signature !== "signed-by-anthropic") {
          return new Response(
            JSON.stringify({ error: { message: "the tool call lost its thinking block" } }),
            { status: 400 }
          )
        }
        return new Response(
          JSON.stringify({
            content: [finalThinking, { type: "text", text: "Invoice INV-4182." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 40, output_tokens: 10 }
          }),
          { status: 200 }
        )
      }
      const completed = asRecords(body.messages).find(
        (message) =>
          message.role === "assistant" &&
          asRecords(message.content).some((block) => block.text === "Invoice INV-4182.")
      )
      if (asRecords(completed?.content)[0]?.signature !== "second") {
        return new Response(
          JSON.stringify({ error: { message: "the completed answer lost its thinking" } }),
          { status: 400 }
        )
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Still INV-4182." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 5 }
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const agent = createAgent({
      modules: [inference({ provider: provider(stub) }), nativeTools([tool])]
    })
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const first = yield* agent.turn({ id: "m-1", text: "Find invoice 4182." })
          const second = yield* agent.turn({ id: "m-2", text: "Repeat the invoice id." })
          return { first, second, log: yield* agent.log }
        }),
        InMemoryRuntime({ keyOf })
      )
    )

    expect(result.first).toMatchObject({ kind: "completed", output: "Invoice INV-4182." })
    expect(result.second).toMatchObject({ kind: "completed", output: "Still INV-4182." })
    expect(bodies).toHaveLength(3)
    expect(
      result.log.filter(
        (event) => event.type === "ModelReturned" && event.continuation !== undefined
      )
    ).toHaveLength(2)

    // The log is what a later process replays, so the blocks have to survive being written down.
    const durable = JSON.parse(JSON.stringify(result.log)) as ReadonlyArray<Event>
    const restored = agent
      .request(durable)
      .messages.find((message) => message.toolCalls !== undefined)?.continuation
    expect(restored?.protocol).toBe("anthropic-messages/v1")
    expect(asRecord(restored?.value)?.blocks).toEqual([thinking])
  })
})
