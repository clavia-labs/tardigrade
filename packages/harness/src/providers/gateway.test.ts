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
      model: "anthropic/test-model",
      contextWindow: 90_000,
      fetch: stub
    })

    expect(provider.state([])).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/test-model",
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
      model: "anthropic/test-model",
      messages: [
        { role: "system", content: "You are a support agent." },
        { role: "user", content: "Find order 4182." },
        { role: "system", content: "Cite the invoice id." }
      ]
    })
  })

  // The key is read from configuration rather than from the machine's environment, so the test
  // supplies the configuration it wants and asks nothing of the machine it runs on.
  test("fails before fetch when no key is configured", async () => {
    let called = false
    const provider = vercelGatewayInference({
      apiKey: "",
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
      fetch: stub
    })
    expect(await Effect.runPromise(provider.react(request, "k"))).toEqual({
      kind: "complete",
      output: "Invoice INV-4182.",
      usage: { promptTokens: 8, completionTokens: 3, costUsd: 0 }
    })
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/chat/completions"
    )
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer cloudflare-token")
    expect(calls[0]?.headers.get("cf-aig-gateway-id")).toBe("support-gateway")
  })

  test("reports missing account configuration without a network call", async () => {
    let called = false
    const provider = cloudflareGatewayInference({
      accountId: "",
      apiToken: "",
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
