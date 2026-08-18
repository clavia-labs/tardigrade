import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelRequest } from "../infer"
import { cloudflareGatewayInference } from "./cloudflare-gateway"
import { vercelGatewayInference } from "./vercel-gateway"

// What a gateway settles before it ever calls a model: which model answers, what that model accepts,
// what it costs, and where the request goes. How a request is made and how a result is read belong
// to the adapter, and `model.test.ts` covers those against a model rather than a wire format.

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
  // The catalog is cached per gateway for the life of the process, so each of these tests names its
  // own gateway and reads its own catalog.
  const gateway = (calls: Array<string>, catalog: unknown) =>
    (async (url: string) => {
      calls.push(String(url))
      if (catalog === undefined) return new Response("no catalog here", { status: 404 })
      return new Response(JSON.stringify(catalog), { status: 200 })
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
        baseUrl: "https://catalog-one.invalid",
        fetch: gateway(calls, models("openai/test-model", 1_000_000))
      })
    )

    // Known before the provider exists, so the projection is a constant from its first read.
    expect(provider.state([]).contextWindow).toBe(1_000_000)
    expect(provider.state([]).maxOutputTokens).toBe(64_000)
    // The catalog is the OpenAI-compatible surface and the model is reached on the SDK's own path,
    // which is why the option names the origin rather than either path.
    expect(calls).toEqual(["https://catalog-one.invalid/v1/models"])
  })

  test("reads the catalog once and serves every later model from it", async () => {
    const calls: Array<string> = []
    const of = (model: string) =>
      Effect.runPromise(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model,
          baseUrl: "https://catalog-two.invalid",
          fetch: gateway(calls, {
            object: "list",
            data: [
              { id: "anthropic/small", context_window: 200_000 },
              { id: "openai/large", context_window: 400_000 }
            ]
          })
        })
      )

    expect((await of("anthropic/small")).state([]).contextWindow).toBe(200_000)
    expect((await of("openai/large")).state([]).contextWindow).toBe(400_000)

    expect(calls).toEqual(["https://catalog-two.invalid/v1/models"])
  })

  // The regression this pins: a window learned mid-session lived in process memory, so a provider
  // that had made a call and one that had not answered differently about the same log. A machine
  // guard folds over this, so the same log folded two ways and a replay diverged from its run.
  test("answers the same about the same log whether or not it has been called", async () => {
    const of = () =>
      Effect.runPromise(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model: "openai/test-model",
          baseUrl: "https://catalog-three.invalid",
          fetch: gateway([], models("openai/test-model", 750_000))
        })
      )

    expect((await of()).state([]).contextWindow).toBe(750_000)
    expect((await of()).state([]).contextWindow).toBe(750_000)
  })

  test("reads published pricing from the catalog", async () => {
    const provider = await Effect.runPromise(
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        baseUrl: "https://catalog-price.invalid",
        fetch: gateway([], {
          object: "list",
          data: [
            {
              id: "openai/test-model",
              context_window: 100_000,
              pricing: { input: "0.001", output: "0.002" }
            }
          ]
        })
      })
    )

    expect(provider.state([]).pricing).toEqual({
      promptUsdPerToken: 0.001,
      completionUsdPerToken: 0.002
    })
  })

  test("takes the caller's context window and asks the gateway nothing", async () => {
    const calls: Array<string> = []
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 123_000,
      fetch: gateway(calls, undefined)
    })

    expect(provider.state([]).contextWindow).toBe(123_000)
    expect(calls).toEqual([])
  })

  // A window this side can not learn is a construction that fails, because a provider that exists
  // reports a real number and there is none to report.
  test("fails to construct when the catalog cannot be read", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model: "openai/test-model",
          baseUrl: "https://catalog-broken.invalid",
          fetch: gateway([], undefined)
        })
      )
    )

    expect(String(failure.message)).toContain("could not read its model catalog")
  })

  test("fails to construct when the catalog lists no such model", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        vercelGatewayInference({
          apiKey: "vercel-key",
          model: "openai/absent-model",
          baseUrl: "https://catalog-absent.invalid",
          fetch: gateway([], models("openai/other-model", 100_000))
        })
      )
    )

    expect(String(failure.message)).toContain("publishes no context window")
  })

  test("a later construction asks again after a catalog read failed", async () => {
    const calls: Array<string> = []
    let healthy = false
    const flaky = (async (url: string) => {
      calls.push(String(url))
      if (!healthy) return new Response("down", { status: 500 })
      return new Response(JSON.stringify(models("openai/test-model", 300_000)), { status: 200 })
    }) as unknown as typeof fetch
    const of = () =>
      vercelGatewayInference({
        apiKey: "vercel-key",
        model: "openai/test-model",
        baseUrl: "https://catalog-flaky.invalid",
        fetch: flaky
      })

    await Effect.runPromise(Effect.flip(of()))
    healthy = true
    const provider = await Effect.runPromise(of())

    expect(provider.state([]).contextWindow).toBe(300_000)
    expect(calls).toHaveLength(2)
  })

  // The window is the one maximum a provider states, and it bounds the whole request. A request past
  // it can not succeed, so it is refused here rather than sent to be refused slowly and in the
  // gateway's words.
  test("refuses a request larger than its configured context window before any call", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "openai/test-model",
      contextWindow: 100,
      fetch: (async () => {
        called = true
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch
    })

    const action = await Effect.runPromise(
      provider.react(
        { ...request, messages: [{ role: "user", content: "word ".repeat(5_000) }] },
        "k"
      )
    )

    expect(action).toMatchObject({ kind: "fail" })
    expect(String(action.kind === "fail" ? action.error : "")).toContain("context window")
    expect(called).toBe(false)
  })
})

describe("Cloudflare AI Gateway", () => {
  // This endpoint speaks the OpenAI-compatible format, so its wire shape is worth one test: the
  // account names the path, the token and the gateway id ride the headers, and the call carries the
  // same idempotency key every other provider sends.
  test("sends its own gateway header and reaches the account's endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) })
      return new Response(
        JSON.stringify({
          id: "one",
          object: "chat.completion",
          created: 0,
          model: "anthropic/test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Invoice INV-4182." },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 8, completion_tokens: 3 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
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

    const action = await Effect.runPromise(provider.react(request, "k"))

    expect(action).toMatchObject({ kind: "complete", output: "Invoice INV-4182." })
    expect(action.usage).toMatchObject({ promptTokens: 8, completionTokens: 3 })
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions"
    )
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer cloudflare-token")
    expect(calls[0]?.headers.get("cf-aig-gateway-id")).toBe("support-gateway")
    expect(calls[0]?.headers.get("idempotency-key")).toBe("k")
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
    expect(String(action.kind === "fail" ? action.error : "")).toContain("CLOUDFLARE_ACCOUNT_ID")
    expect(called).toBe(false)
  })
})
