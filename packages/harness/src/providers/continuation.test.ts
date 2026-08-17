import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import type { NativeTool } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { inference } from "../modules/inference"
import { nativeTools } from "../modules/native-tools"
import { cloudflareGatewayInference } from "./cloudflare-gateway"
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

const tool: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice.",
    inputSchema: { type: "object" }
  },
  run: () => Effect.succeed({ invoice: "INV-4182" })
}

describe("provider continuation", () => {
  // Gemini requires the thought signature from a function call on the next request. The gateway
  // puts it in an OpenAI extension field. This test follows the complete Flamework path, because a
  // provider-only test would miss the event that dropped the field before the second model call.
  test("round-trips opaque provider fields through tools and later turns", async () => {
    const signature = "encrypted-thought-signature"
    const finalReasoning = [{ type: "reasoning.encrypted", data: "final-state" }]
    const bodies: Array<Readonly<Record<string, unknown>>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      const body = asRecord(JSON.parse(String(init.body))) ?? {}
      bodies.push(body)
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "I will look it up.",
                  reasoning_details: [{ type: "reasoning.encrypted", data: "tool-state" }],
                  provider_metadata: { gateway: { provider: "google" } },
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "lookup_invoice", arguments: "{}" },
                      extra_content: { google: { thought_signature: signature } }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      }
      if (bodies.length === 2) {
        const assistant = asRecords(body.messages).find(
          (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
        )
        const call = asRecords(assistant?.tool_calls)[0]
        const extra = asRecord(call?.extra_content)
        const google = asRecord(extra?.google)
        if (google?.thought_signature !== signature) {
          return new Response(
            JSON.stringify({ error: { message: "the function call is missing a thought signature" } }),
            { status: 400 }
          )
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Invoice INV-4182.",
                  reasoning_details: finalReasoning,
                  provider_metadata: { gateway: { provider: "google" } }
                }
              }
            ]
          }),
          { status: 200 }
        )
      }
      const completed = asRecords(body.messages).find(
        (message) => message.role === "assistant" && message.content === "Invoice INV-4182."
      )
      if (JSON.stringify(completed?.reasoning_details) !== JSON.stringify(finalReasoning)) {
        return new Response(
          JSON.stringify({ error: { message: "the completed answer lost its reasoning state" } }),
          { status: 400 }
        )
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "Still INV-4182." } }] }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const provider = vercelGatewayInference({
      apiKey: "vercel-key",
      model: "google/gemini-3.1-pro-preview",
      contextWindow: 1_000_000,
      retries: 0,
      fetch: stub
    })
    const agent = createAgent({ modules: [inference({ provider }), nativeTools([tool])] })
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
    const continued = asRecords(bodies[1]?.messages).find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
    )
    expect(continued?.reasoning_details).toEqual([
      { type: "reasoning.encrypted", data: "tool-state" }
    ])
    expect(continued).not.toHaveProperty("provider_metadata")
    expect(
      result.log.filter(
        (event) => event.type === "ModelReturned" && event.continuation !== undefined
      )
    ).toHaveLength(2)
    const durable = JSON.parse(JSON.stringify(result.log)) as ReadonlyArray<Event>
    const restored = asRecord(
      agent.request(durable).messages.find((message) => message.toolCalls !== undefined)?.continuation
    )
    const restoredValue = asRecord(restored?.value)
    const restoredCall = asRecord(restoredValue?.toolCall)
    const restoredExtra = asRecord(restoredCall?.extra_content)
    const restoredGoogle = asRecord(restoredExtra?.google)
    expect(durable).toEqual(result.log)
    expect(restoredGoogle?.thought_signature).toBe(signature)
  })

  // Every gateway in this package is built from the one OpenAI-compatible provider, so the round
  // trip belongs to all of them. This pins that for the second gateway, because a fix that lived in
  // a gateway rather than in the provider would leave this one carrying nothing.
  test("travels the Cloudflare gateway too, because the provider is the same", async () => {
    const bodies: Array<Readonly<Record<string, unknown>>> = []
    const stub = (async (_url: string, init: RequestInit) => {
      bodies.push(asRecord(JSON.parse(String(init.body))) ?? {})
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_details: [{ type: "reasoning.encrypted", data: "cloudflare-state" }],
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "lookup_invoice", arguments: "{}" }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "Invoice INV-4182." } }] }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const provider = cloudflareGatewayInference({
      accountId: "account-1",
      apiToken: "cloudflare-token",
      model: "google/gemini-3.1-pro-preview",
      contextWindow: 1_000_000,
      retries: 0,
      fetch: stub
    })
    const agent = createAgent({ modules: [inference({ provider }), nativeTools([tool])] })
    const outcome = await Effect.runPromise(
      Effect.provide(
        agent.turn({ id: "m-1", text: "Find invoice 4182." }),
        InMemoryRuntime({ keyOf })
      )
    )

    expect(outcome).toMatchObject({ kind: "completed", output: "Invoice INV-4182." })
    const continued = asRecords(bodies[1]?.messages).find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
    )
    expect(continued?.reasoning_details).toEqual([
      { type: "reasoning.encrypted", data: "cloudflare-state" }
    ])
  })
})
