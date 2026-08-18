import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { MockLanguageModelV4 } from "ai/test"
import type { NativeTool } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { inference } from "../modules/inference"
import { nativeTools } from "../modules/native-tools"
import { modelInference } from "./model"

// The failure this pins is the quiet one. A model works something out, calls a tool, and the next
// request has to carry the state that proves it did. A gateway answers a request that lost that
// state with the same 200 as one that kept it, so nothing downstream says anything was lost.
//
// The whole Flamework path is under test rather than the adapter alone, because the state has to
// survive being written to the log as an event, read back by the renderer, and sent again. A
// provider-only test would miss the step that dropped it.

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const tool: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice.",
    inputSchema: { type: "object" }
  },
  run: () => Effect.succeed({ invoice: "INV-4182" })
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, reasoning: 0, prediction: undefined }
} as never

const answered = (content: Array<Record<string, unknown>>) =>
  ({
    content,
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: []
  }) as never

// Every reasoning part the model sent, wherever it sits in the prompt the SDK built.
const reasoningIn = (options: LanguageModelV4CallOptions | undefined) =>
  (options?.prompt ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => asRecord(part)?.type === "reasoning")
      : []
  )

describe("provider continuation", () => {
  test("round-trips opaque provider state through a tool call and a later turn", async () => {
    const signature = "encrypted-thought-signature"
    const seen: Array<LanguageModelV4CallOptions> = []
    const languageModel = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options)
        if (seen.length === 1) {
          return answered([
            {
              type: "reasoning",
              text: "I should look this up.",
              providerMetadata: { google: { thought_signature: signature } }
            },
            { type: "tool-call", toolCallId: "call-1", toolName: "lookup_invoice", input: {} }
          ])
        }
        if (seen.length === 2) {
          return answered([
            {
              type: "reasoning",
              text: "The tool answered.",
              providerMetadata: { google: { thought_signature: "final-state" } }
            },
            { type: "text", text: "Invoice INV-4182." }
          ])
        }
        return answered([{ type: "text", text: "Still INV-4182." }])
      }
    })
    const provider = modelInference({
      id: "test",
      provider: "test-gateway",
      model: "google/test-model",
      contextWindow: 1_000_000,
      retries: 0,
      languageModel
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
    expect(seen).toHaveLength(3)

    // The request that follows the tool result carries the thinking that produced the call, with the
    // state that proves it. Without this the model answers again from nothing and says so nowhere.
    const afterTool = reasoningIn(seen[1])
    expect(afterTool).toHaveLength(1)
    expect(asRecord(asRecord(afterTool[0])?.providerOptions)).toEqual({
      google: { thought_signature: signature }
    })

    // And the next turn still carries what the completed answer worked out.
    expect(
      reasoningIn(seen[2]).map((part) => asRecord(asRecord(part)?.providerOptions)?.google)
    ).toContainEqual({ thought_signature: "final-state" })
  })

  test("survives the log being written and read back as JSON", async () => {
    const signature = "durable-signature"
    const languageModel = new MockLanguageModelV4({
      doGenerate: async () =>
        answered([
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { google: { thought_signature: signature } }
          },
          { type: "text", text: "done" }
        ])
    })
    const provider = modelInference({
      id: "test",
      provider: "test-gateway",
      model: "google/test-model",
      contextWindow: 1_000_000,
      retries: 0,
      languageModel
    })
    const agent = createAgent({ modules: [inference({ provider })] })

    const log = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* agent.turn({ id: "m-1", text: "hello" })
          return yield* agent.log
        }),
        InMemoryRuntime({ keyOf })
      )
    )

    // A durable runtime stores the log as JSON, so what a restart reads is this, not the objects the
    // run happened to hold.
    const durable = JSON.parse(JSON.stringify(log)) as ReadonlyArray<Event>
    expect(durable).toEqual(log)
    const restored = agent
      .request(durable)
      .messages.find((message) => message.role === "assistant")?.continuation
    expect(restored?.protocol).toBe("ai-sdk/v1")
    expect(JSON.stringify(restored?.value)).toContain(signature)
  })
})
