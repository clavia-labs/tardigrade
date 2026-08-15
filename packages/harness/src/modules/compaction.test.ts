import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { checkpointOf, estimateTokens, keepUpTo, suffixOf } from "../context"
import { inferWith, type InferenceProvider } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { vercelGatewayInference } from "../providers/vercel-gateway"
import { modelRequest } from "../render"
import { inference } from "./inference"
import { morphCompaction, naiveSummary, type MorphOptions } from "./compaction"

// No test in this suite reaches the network. The transport is a seam, and the path with no key
// never calls out at all.

const refuses = inferWith(async () => {
  throw new Error("compaction called the model")
}, { contextWindow: 200_000 })

const turn = (id: string, at: number): ReadonlyArray<Event> => [
  { type: "MessageReceived", id, text: `question ${id}`, at },
  { type: "TurnCompleted", turn: id, output: `answer ${id}`, at: at + 1 },
  { type: "ReplyDelivered", turn: id, at: at + 2 }
]

const history = [...turn("m-1", 1), ...turn("m-2", 10), ...turn("m-3", 20)]

const compacted = (options: MorphOptions, seed: ReadonlyArray<Event>) => {
  const agent = createAgent({ modules: [inference({ contextWindow: 200_000 }), morphCompaction(options)] })
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* agent.replay(seed)
        return yield* agent.log
      }),
      Layer.merge(InMemoryRuntime({ keyOf }), refuses)
    )
  )
}

const tiny: MorphOptions = { fireTokens: 1, keepTokens: 1 }

describe("the context projections", () => {
  test("estimates tokens as bytes over four", () => {
    expect(estimateTokens([{ type: "A" }])).toBe(Math.ceil('{"type":"A"}'.length / 4))
    expect(estimateTokens([])).toBe(0)
  })

  test("the checkpoint is the last one on the record", () => {
    const log: ReadonlyArray<Event> = [
      { type: "CompactionCompleted", upTo: 2, summary: "first", at: 1 },
      { type: "CompactionCompleted", upTo: 5, summary: "second", at: 2 }
    ]
    expect(checkpointOf(log)).toEqual({ upTo: 5, summary: "second" })
    expect(checkpointOf([])).toEqual({ upTo: 0, summary: "" })
  })

  test("the suffix is what a render sees", () => {
    const log = [...history, { type: "CompactionCompleted", upTo: 6, summary: "s", at: 30 }]
    expect(suffixOf(log)).toHaveLength(log.length - 6)
  })

  test("the retained tail is bounded by tokens, and always keeps the newest event", () => {
    expect(keepUpTo(history, 1)).toBe(history.length - 1)
    expect(keepUpTo(history, 100_000)).toBe(0)
    expect(keepUpTo([], 10)).toBe(0)
  })
})

describe("the local fallback", () => {
  test("runs when the key is missing, and the event records which path ran", async () => {
    const log = await compacted(tiny, [...history, { type: "CompactionFired", at: 40 }])
    const checkpoint = log.find((event) => event.type === "CompactionCompleted")
    expect(checkpoint?.provider).toBe("fallback")
    expect(String(checkpoint?.summary)).toContain("question m-1")
    expect(Number(checkpoint?.upTo)).toBeGreaterThan(0)
  })

  test("runs when the call fails, and the turn continues either way", async () => {
    const offline = (async () => {
      throw new Error("the network is down")
    }) as unknown as typeof fetch
    const log = await compacted({ ...tiny, apiKey: "k", fetch: offline }, [
      ...history,
      { type: "CompactionFired", at: 40 }
    ])
    expect(log.find((event) => event.type === "CompactionCompleted")?.provider).toBe(
      "fallback"
    )
  })

  test("runs when the call answers with an error status", async () => {
    const broken = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    const log = await compacted({ ...tiny, apiKey: "k", fetch: broken }, [
      ...history,
      { type: "CompactionFired", at: 40 }
    ])
    expect(log.find((event) => event.type === "CompactionCompleted")?.provider).toBe(
      "fallback"
    )
  })

  test("compresses rather than tidies", () => {
    const input = "line one\nline two\nline three\n".repeat(20)
    const summary = naiveSummary(input, 0.5)
    expect(summary.length).toBeLessThan(input.length)
    expect(summary).toContain("chars elided")
  })

  // Both thresholds are ratios of the model's window, so the window the provider holds is what
  // decides them. A wider model reads more before anything is summarized away.
  const firedWith = (provider: InferenceProvider, seed: ReadonlyArray<Event>) => {
    const agent = createAgent({ modules: [inference({ provider }), morphCompaction()] })
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* agent.replay(seed)
          return (yield* agent.log).some((event) => event.type === "CompactionCompleted")
        }),
        Layer.merge(InMemoryRuntime({ keyOf }), refuses)
      )
    )
  }

  test("fires against the window the provider reports", async () => {
    expect(await firedWith(vercelGatewayInference({ contextWindow: 100 }), history)).toBe(true)
    expect(await firedWith(vercelGatewayInference({ contextWindow: 200_000 }), history)).toBe(false)
  })
})

describe("the morph path", () => {
  test("posts the documented request and takes the output back", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string }> = []
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        authorization: String((init.headers as Record<string, string>).authorization)
      })
      return new Response(JSON.stringify({ output: "The user asked about three orders." }), {
        status: 200
      })
    }) as unknown as typeof fetch

    const log = await compacted(
      { ...tiny, apiKey: "morph-key", compressionRatio: 0.25, fetch: stub },
      [...history, { type: "CompactionFired", at: 40 }]
    )

    const checkpoint = log.find((event) => event.type === "CompactionCompleted")
    expect(checkpoint?.provider).toBe("morph")
    expect(checkpoint?.summary).toBe("The user asked about three orders.")
    expect(calls[0]?.url).toBe("https://api.morphllm.com/v1/compact")
    expect(calls[0]?.authorization).toBe("Bearer morph-key")
    expect(calls[0]?.body).toMatchObject({
      query: "question m-3",
      compression_ratio: 0.25,
      preserve_recent: 0
    })
    expect(String((calls[0]?.body as { input?: string } | undefined)?.input)).toContain("question m-1")
  })

  test("an apiUrl option moves the endpoint", async () => {
    const seen: Array<string> = []
    const stub = (async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ output: "s" }), { status: 200 })
    }) as unknown as typeof fetch
    await compacted({ ...tiny, apiKey: "k", apiUrl: "https://example.test/v2", fetch: stub }, [
      ...history,
      { type: "CompactionFired", at: 40 }
    ])
    expect(seen[0]).toBe("https://example.test/v2/compact")
  })
})

describe("hysteresis", () => {
  test("fires at a turn's end when the suffix passes the threshold", async () => {
    const log = await compacted(tiny, history)
    expect(log.filter((event) => event.type === "CompactionCompleted")).toHaveLength(1)
  })

  test("rests while the suffix is under the threshold", async () => {
    const log = await compacted({ fireTokens: 100_000 }, history)
    expect(log.filter((event) => event.type === "CompactionCompleted")).toHaveLength(0)
  })

  test("appends a checkpoint and deletes nothing", async () => {
    const log = await compacted(tiny, [...history, { type: "CompactionFired", at: 40 }])
    // Every byte of the history is still there, in order, with the checkpoint appended after it.
    expect(log.slice(0, history.length)).toEqual(history)
    expect(log.at(-1)?.type).toBe("CompactionCompleted")
  })

  test("the render reads the summary in place of the compacted span", async () => {
    const log = await compacted(tiny, [...history, { type: "CompactionFired", at: 40 }])
    const program = {
      render: {
        instructions: [],
        nativeTools: [],
        nudges: [],
        messageTruncateAt: 12_000,
        resultTruncateAt: 6_000
      }
    }
    const messages = modelRequest(program, log).messages
    expect(messages[0]?.content).toContain("Summary of earlier work:")
    // The whole history collapsed to the summary plus the retained tail.
    expect(messages.length).toBeLessThan(modelRequest(program, history).messages.length)
  })
})
