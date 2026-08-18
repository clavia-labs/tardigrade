import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import type { ModelRequest } from "../infer"
import { cloudflareGatewayInference } from "./cloudflare-gateway"
import { vercelGatewayInference } from "./vercel-gateway"

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

describe("Vercel AI Gateway", () => {
  test("is configured by an explicit key and sends an OpenAI-compatible request", async () => {
    const calls: Array<{
      readonly url: string
      readonly headers: Headers
      readonly body: Record<string, unknown>
    }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>
      })
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Looking it up.",
                tool_calls: [
                  {
                    id: "c-1",
                    function: {
                      name: "lookup_invoice",
                      arguments: '{"orderId":"4182"}'
                    }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, cost_usd: 0.001 }
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 90_000,
      fetch: stub
    })

    expect(provider.state([])).toEqual({
      provider: "vercel-ai-gateway",
      model: "openai/test-model",
      contextWindow: 90_000
    })
    expect(await Effect.runPromise(provider.react(request, "turn/infer/0"))).toEqual({
      kind: "call",
      callId: "c-1",
      name: "lookup_invoice",
      arguments: { orderId: "4182" },
      text: "Looking it up.",
      usage: { promptTokens: 10, completionTokens: 4, costUsd: 0.001 }
    })
    expect(calls[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer vercel-key")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("turn/infer/0")
    expect(calls[0]?.body).toMatchObject({
      model: "openai/test-model",
      parallel_tool_calls: false,
      messages: [
        { role: "system", content: "You are a support agent." },
        { role: "user", content: "Find order 4182." },
        { role: "system", content: "Cite the invoice id." }
      ]
    })
  })

  // A gateway that runs out of completion tokens returns the fragment it had, and the fragment
  // arrives in the shape of an answer. Reading it as one is a silent truncation: the turn completes
  // on half a sentence and nothing in the log says the model never finished.
  const stoppedAtLimit = (message: Record<string, unknown>) =>
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message }],
          usage: { prompt_tokens: 900, completion_tokens: 4096, cost_usd: 0.02 }
        }),
        { status: 200 }
      )) as unknown as typeof fetch

  test("records an answer the gateway stopped at its completion-token limit", async () => {
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 200_000,
      fetch: stoppedAtLimit({ content: "The lease was signed on 29 August 2025 and the term" })
    })

    const action = await Effect.runPromise(provider.react(request, "k"))

    expect(action).toEqual({
      kind: "truncated",
      text: "The lease was signed on 29 August 2025 and the term",
      usage: { promptTokens: 900, completionTokens: 4096, costUsd: 0.02 }
    })
  })

  test("records a tool call whose arguments stop mid-JSON as text", async () => {
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 200_000,
      fetch: stoppedAtLimit({
        tool_calls: [{ id: "c-1", function: { name: "lookup_invoice", arguments: '{"orderId":"41' } }]
      })
    })

    expect(await Effect.runPromise(provider.react(request, "k"))).toMatchObject({
      kind: "truncated",
      text: `[truncated tool call lookup_invoice: {"orderId":"41]`
    })
  })

  test("refuses multiple tool calls instead of dropping all but the first", async () => {
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 200_000,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    { id: "c-1", function: { name: "lookup_invoice", arguments: "{}" } },
                    { id: "c-2", function: { name: "lookup_invoice", arguments: "{}" } }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, cost_usd: 0.001 }
          }),
          { status: 200 }
        )) as unknown as typeof fetch
    })

    const action = await Effect.runPromise(provider.react(request, "k"))

    expect(action.kind).toBe("fail")
    const reason = String(action.kind === "fail" ? action.error : "")
    expect(reason).toContain("multiple tool calls")
    expect(reason).toContain("routes")
    expect(action.usage).toEqual({ promptTokens: 10, completionTokens: 4, costUsd: 0.001 })
  })

  // The defect this pins: `routes` was accepted on the gateway options and applied only on the
  // Anthropic path, so a DeepSeek (or any other OpenAI-compatible) model silently dropped it.
  test("pins a route on the OpenAI-compatible path when the caller names one", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      })
    }) as unknown as typeof fetch
    const of = (routes?: ReadonlyArray<string>) =>
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "deepseek/deepseek-v4-pro",
        contextWindow: 200_000,
        fetch: stub,
        ...(routes === undefined ? {} : { routes })
      })

    await Effect.runPromise(of().react(request, "k"))
    await Effect.runPromise(of(["deepseek"]).react(request, "k"))

    expect(bodies[0]).not.toHaveProperty("providerOptions")
    expect(bodies[1]?.providerOptions).toEqual({ gateway: { only: ["deepseek"] } })
  })

  test("sends a per-request service tier on the OpenAI-compatible path", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      })
    }) as unknown as typeof fetch
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "google/gemini-3.1-pro",
      contextWindow: 200_000,
      fetch: stub
    })

    await Effect.runPromise(provider.react({ ...request, options: { serviceTier: "flex" } }, "k"))

    expect(bodies[0]?.service_tier).toBe("flex")
  })

  test("a reported zero stays zero, and an omitted cost stays absent", async () => {
    const of = (usage: unknown) =>
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        contextWindow: 200_000,
        fetch: (async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "ok" } }], usage }),
            { status: 200 }
          )) as unknown as typeof fetch
      })

    const zero = await Effect.runPromise(
      of({ prompt_tokens: 8, completion_tokens: 3, cost: 0 }).react(request, "k")
    )
    const omitted = await Effect.runPromise(
      of({ prompt_tokens: 8, completion_tokens: 3 }).react(request, "k")
    )

    expect(zero.kind === "complete" ? zero.usage : undefined).toEqual({
      promptTokens: 8,
      completionTokens: 3,
      costUsd: 0
    })
    expect(omitted.kind === "complete" ? omitted.usage : undefined).toEqual({
      promptTokens: 8,
      completionTokens: 3
    })
  })

  // The catalog is cached per gateway for the life of the process, so each of these tests names its
  // own gateway and reads its own catalog.
  const gateway = (
    calls: Array<string>,
    catalog: unknown,
    completion: unknown = { choices: [{ message: { content: "ok" } }] }
  ) =>
    (async (url: string) => {
      calls.push(String(url))
      const body = String(url).endsWith("/models") ? catalog : completion
      if (body === undefined) return new Response("no catalog here", { status: 404 })
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

  const models = (id: string, window: number) => ({
    object: "list",
    data: [{ id, object: "model", context_window: window, max_tokens: 64_000 }]
  })

  // The window belongs to the model, and the gateway publishes it per model. Reading it there is
  // what keeps a figure this side invented out of the decision, and asking is an effect, so the
  // constructor that asks is one.
  test("reads the model's context window from the gateway catalog", async () => {
    const calls: Array<string> = []
    const provider = await Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        baseUrl: "https://catalog-one.invalid/v1",
        fetch: gateway(calls, models("openai/test-model", 1_000_000))
      })
    )

    // Known before the provider exists, so the projection is a constant from its first read.
    expect(provider.state([]).contextWindow).toBe(1_000_000)
    await Effect.runPromise(provider.react(request, "k"))

    expect(calls).toEqual([
      "https://catalog-one.invalid/v1/models",
      "https://catalog-one.invalid/v1/chat/completions"
    ])
  })

  test("reads the catalog once and serves every later model from it", async () => {
    const calls: Array<string> = []
    const of = (model: string) =>
      Effect.runPromise(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model,
          baseUrl: "https://catalog-two.invalid/v1",
          fetch: gateway(calls, {
            object: "list",
            data: [
              { id: "anthropic/small", context_window: 200_000 },
              { id: "anthropic/large", context_window: 1_000_000 }
            ]
          })
        })
      )

    expect((await of("anthropic/small")).state([]).contextWindow).toBe(200_000)
    expect((await of("anthropic/large")).state([]).contextWindow).toBe(1_000_000)
    expect((await of("anthropic/small")).state([]).contextWindow).toBe(200_000)
    expect(calls.filter((url) => url.endsWith("/models"))).toEqual([
      "https://catalog-two.invalid/v1/models"
    ])
  })

  // The regression this pins: a window learned mid-session lived in process memory, so a provider
  // that had made a call and one that had not answered differently about the same log. A machine
  // guard folds over this, so the same log folded two ways and a replay diverged from its run.
  test("answers the same about the same log whether or not it has been called", async () => {
    const calls: Array<string> = []
    const of = () =>
      Effect.runPromise(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model: "anthropic/test-model",
          baseUrl: "https://catalog-seven.invalid/v1",
          fetch: gateway(calls, models("anthropic/test-model", 750_000))
        })
      )

    const used = await of()
    await Effect.runPromise(used.react(request, "k"))
    const fresh = await of()

    expect(fresh.state([])).toEqual(used.state([]))
    expect(fresh.state([]).contextWindow).toBe(750_000)
  })

  test("reads published pricing from the catalog and prices an omitted cost", async () => {
    const provider = await Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        baseUrl: "https://catalog-price.invalid/v1",
        fetch: gateway(
          [],
          {
            object: "list",
            data: [
              {
                id: "openai/test-model",
                context_window: 100_000,
                pricing: { input: "0.001", output: "0.002" }
              }
            ]
          },
          {
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 }
          }
        )
      })
    )

    expect(provider.state([]).pricing).toEqual({
      promptUsdPerToken: 0.001,
      completionUsdPerToken: 0.002
    })
    const action = await Effect.runPromise(provider.react(request, "k"))
    expect(action.kind === "complete" ? action.usage : undefined).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 10 * 0.001 + 4 * 0.002
    })
  })

  test("takes the caller's context window and asks the gateway nothing", async () => {
    const calls: Array<string> = []
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      contextWindow: 42_000,
      baseUrl: "https://catalog-three.invalid/v1",
      fetch: gateway(calls, models("anthropic/claude-sonnet-4.6", 1_000_000))
    })

    await Effect.runPromise(provider.react(request, "k"))

    expect(provider.state([]).contextWindow).toBe(42_000)
    expect(calls.some((url) => url.endsWith("/models"))).toBe(false)
  })

  // A window this side can not learn is a construction that fails, because a provider that exists
  // reports a real number and there is none to report.
  test("fails to construct when the catalog cannot be read", async () => {
    const calls: Array<string> = []
    const built = Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        baseUrl: "https://catalog-four.invalid/v1",
        fetch: gateway(calls, undefined)
      })
    )

    expect(built).rejects.toThrow("could not read its model catalog")
  })

  test("fails to construct when the catalog lists no such model", async () => {
    const calls: Array<string> = []
    const built = Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "anthropic/unlisted",
        baseUrl: "https://catalog-six.invalid/v1",
        fetch: gateway(calls, models("anthropic/listed", 1_000))
      })
    )

    expect(built).rejects.toThrow('publishes no context window for "anthropic/unlisted"')
  })

  test("a later construction asks again after a catalog read failed", async () => {
    const calls: Array<string> = []
    const of = () =>
      Effect.runPromise(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model: "anthropic/test-model",
          baseUrl: "https://catalog-five.invalid/v1",
          fetch: gateway(
            calls,
            calls.some((url) => url.endsWith("/models"))
              ? models("anthropic/test-model", 500_000)
              : undefined
          )
        })
      )

    await of().catch(() => undefined)
    expect((await of()).state([]).contextWindow).toBe(500_000)
  })

  // The window is the one maximum a provider states, and it bounds the whole request. A request past
  // it can not succeed, so it is refused here rather than sent to be refused slowly and in the
  // gateway's words.
  test("refuses a request larger than its configured context window before fetch", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      contextWindow: 1_000,
      fetch: (async () => {
        called = true
        return new Response()
      }) as unknown as typeof fetch
    })

    const action = await Effect.runPromise(
      provider.react(
        { ...request, messages: [{ role: "user", content: "x".repeat(40_000) }] },
        "k"
      )
    )

    expect(called).toBe(false)
    expect(action.kind).toBe("fail")
    const reason = String(action.kind === "fail" ? action.error : "")
    // The refusal names both numbers and the setting that decides one of them, so the assumption the
    // provider made is readable at the moment it binds.
    expect(reason).toMatch(/at least 10\d{3} tokens/)
    expect(reason).toContain("context window of 1000 tokens")
    expect(reason).toContain("contextWindow")
    expect(action.usage).toBeUndefined()
  })

  test("reserves the output ceiling when it checks the window", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      contextWindow: 5_000,
      maxOutputTokens: 9_000,
      fetch: (async () => {
        called = true
        return new Response()
      }) as unknown as typeof fetch
    })

    const action = await Effect.runPromise(provider.react(request, "k"))

    expect(called).toBe(false)
    expect(action.kind).toBe("fail")
    expect(String(action.kind === "fail" ? action.error : "")).toContain("reserved for the answer")
  })

  test("sends a request that fits its configured context window", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 1_000,
      fetch: (async () => {
        called = true
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200
        })
      }) as unknown as typeof fetch
    })

    expect(await Effect.runPromise(provider.react(request, "k"))).toMatchObject({ kind: "complete" })
    expect(called).toBe(true)
  })

  // The ceiling on one answer. Without it the gateway's own default for the model decides, and a
  // default sized for chat cuts off a long generated source file. A truncated answer is recorded so
  // the turn can continue from the fragment, and `maxOutputTokens` is the option that moves the
  // ceiling.
  test("sends the output ceiling a caller states, and none when they state none", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200
      })
    }) as unknown as typeof fetch
    const of = (maxOutputTokens?: number) =>
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        contextWindow: 200_000,
        fetch: stub,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
      })

    await Effect.runPromise(of(32_000).react(request, "k"))
    await Effect.runPromise(of().react(request, "k"))

    expect(bodies[0]?.max_tokens).toBe(32_000)
    // Absent rather than a figure this side chose, so the model's own default decides.
    expect(bodies[1]).not.toHaveProperty("max_tokens")
  })

  // The defect this pins: the provider accepted a timeout, a retry count, and headers, and the
  // gateway that builds it forwarded none of them. A caller in front of a slow model had no way to
  // move the bound except to reimplement the provider.
  test("forwards the transport settings a caller states", async () => {
    const seen: Array<Headers> = []
    const stub = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return await new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      contextWindow: 200_000,
      headers: { "x-trace": "abc" },
      retries: 0,
      timeout: "10 millis",
      fetch: stub
    })

    const action = await Effect.runPromise(provider.react(request, "k"))

    expect(action.kind).toBe("defer")
    expect(String(action.kind === "defer" ? action.error : "")).toContain("timeout")
    // One attempt, because the caller asked for no retries.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.get("x-trace")).toBe("abc")
  })

  // The key is read from configuration rather than from the machine's environment, so the test
  // supplies the configuration it wants and asks nothing of the machine it runs on.
  test("fails before fetch when no key is configured", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "",
      contextWindow: 200_000,
      fetch: (async () => {
        called = true
        return new Response()
      }) as unknown as typeof fetch
    })
    const action = await Effect.runPromise(
      Effect.provide(
        provider.react(request, "k"),
        ConfigProvider.layer(ConfigProvider.fromUnknown({}))
      )
    )
    expect(action).toMatchObject({ kind: "fail" })
    expect(String(action.kind === "fail" ? action.error : "")).toContain("AI_GATEWAY_API_KEY")
    expect(called).toBe(false)
  })

  test("reads the key from configuration when none is passed", async () => {
    const seen: Array<string> = []
    const provider = vercelGatewayInference({
      contextWindow: 200_000,
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(String(new Headers(init.headers).get("authorization")))
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200
        })
      }) as unknown as typeof fetch
    })
    await Effect.runPromise(
      Effect.provide(
        provider.react(request, "k"),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "from-config" }))
      )
    )
    expect(seen).toEqual(["Bearer from-config"])
  })
})

describe("Cloudflare AI Gateway", () => {
  // No catalog on this path, so the caller is the only one who can say what the model accepts, and
  // an absent answer is a construction that fails rather than a number this side chose.
  test("refuses to build without a window it has no way to learn", () => {
    expect(() => cloudflareGatewayInference({ accountId: "a", apiToken: "t" })).toThrow(
      "CLOUDFLARE_AI_CONTEXT_WINDOW"
    )
  })

  test("uses the current account endpoint and optional gateway header", async () => {
    const calls: Array<{ readonly url: string; readonly headers: Headers }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Invoice INV-4182." } }],
          usage: { prompt_tokens: 8, completion_tokens: 3 }
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    const provider = cloudflareGatewayInference({
      accountId: "account-1",
      apiToken: "cloudflare-token",
      gatewayId: "support-gateway",
      model: "anthropic/test-model",
      contextWindow: 200_000,
      fetch: stub
    })
    expect(await Effect.runPromise(provider.react(request, "k"))).toEqual({
      kind: "complete",
      output: "Invoice INV-4182.",
      usage: { promptTokens: 8, completionTokens: 3 }
    })
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions"
    )
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer cloudflare-token")
    expect(calls[0]?.headers.get("cf-aig-gateway-id")).toBe("support-gateway")
  })

  test("forwards the transport settings beside its own gateway header", async () => {
    const seen: Array<Headers> = []
    const stub = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return await new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const provider = cloudflareGatewayInference({
      accountId: "account-1",
      apiToken: "cloudflare-token",
      gatewayId: "support-gateway",
      contextWindow: 200_000,
      headers: { "x-trace": "abc" },
      retries: 0,
      timeout: "10 millis",
      fetch: stub
    })

    await Effect.runPromise(provider.react(request, "k"))

    expect(seen[0]?.get("x-trace")).toBe("abc")
    expect(seen[0]?.get("cf-aig-gateway-id")).toBe("support-gateway")
  })

  test("reports missing account configuration without a network call", async () => {
    let called = false
    const provider = cloudflareGatewayInference({
      accountId: "",
      apiToken: "",
      contextWindow: 200_000,
      fetch: (async () => {
        called = true
        return new Response()
      }) as unknown as typeof fetch
    })
    const action = await Effect.runPromise(provider.react(request, "k"))
    expect(action).toMatchObject({ kind: "fail" })
    expect(String(action.kind === "fail" ? action.error : "")).toContain(
      "CLOUDFLARE_ACCOUNT_ID"
    )
    expect(called).toBe(false)
  })
})
