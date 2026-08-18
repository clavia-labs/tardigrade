import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Infer } from "@flamecast/agent/infer"
import { actionOf, modelAskOf, modelIdOf, realInfer } from "./model"

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

  // The schema a research task declares for its scout, and the answer that broke a prod run:
  // the array arrived as a string holding a stringified copy of the whole object, so the code
  // that read `.aspects.map` got a string.
  const SCOUT = {
    type: "object",
    properties: {
      aspects: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"]
        }
      }
    },
    required: ["aspects"]
  }

  test("an answer that satisfies the schema completes", () => {
    const good = JSON.stringify({ aspects: [{ name: "a", description: "b" }] })
    const action = actionOf(
      { content: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "answer", arguments: good } }] } as never,
      SCOUT
    )
    expect(action).toEqual({ kind: "complete", output: good })
  })

  test("a double-encoded answer goes back for repair instead of completing", () => {
    const doubled = JSON.stringify({ aspects: JSON.stringify({ aspects: [{ name: "a", description: "b" }] }) })
    const action = actionOf(
      { content: "", toolCalls: [{ id: "call_2", type: "function", function: { name: "answer", arguments: doubled } }] } as never,
      SCOUT
    )
    expect(action).toMatchObject({ kind: "call", callId: "call_2", name: "answer" })
  })

  test("prose cannot satisfy a schema", () => {
    const action = actionOf({ content: "here are the aspects", toolCalls: [] } as never, SCOUT)
    expect(action).toMatchObject({ kind: "call", name: "answer" })
    // With nothing declared, the same prose is a perfectly good terminal.
    expect(actionOf({ content: "here are the aspects", toolCalls: [] } as never)).toEqual({
      kind: "complete",
      output: "here are the aspects"
    })
  })
})

const sse = (events: ReadonlyArray<unknown>): Response => {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("realInfer end to end", () => {
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
    const layer = realInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      packagesInScope: "- zohorecruit",
      fetch: fetchImpl
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) =>
        model.react([{ type: "MessageReceived", id: "m1", text: "compute", at: 1 }])
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
    const layer = realInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", packagesInScope: "", fetch: fetchImpl })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react([{ type: "MessageReceived", id: "m1", text: "2+2?", at: 1 }])).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(action).toEqual({ kind: "complete", output: "the answer is 4" })
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
    const layer = realInfer({ baseUrl: "https://model.test/v1", apiKey: "k", model: "test-model", packagesInScope: "", fetch: fetchImpl })
    const trajectory = [{ type: "MessageReceived", id: "m1", text: "go", at: 1 }]
    await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(trajectory, "m1/infer/0")).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react(trajectory)).pipe(Effect.provide(layer)) as Effect.Effect<unknown>
    )
    expect(seen).toEqual(["m1/infer/0", null])
  })
})

// A throttle-shaped failure (429, 5xx, a stream timeout) retries inside the one act, so the
// give-up fold in src/agent/infer.ts only ever counts a died attempt when the retries themselves
// are exhausted. `sleep` is the test seam that swaps the real backoff wait for an instant one, so
// these run in milliseconds instead of tens of seconds.
describe("realInfer: throttle-shaped retry", () => {
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
    const layer = realInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      packagesInScope: "",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    const action = await Effect.runPromise(
      Effect.flatMap(Infer, (model) => model.react([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }])).pipe(
        Effect.provide(layer)
      ) as Effect.Effect<unknown>
    )
    expect(action).toEqual({ kind: "complete", output: "ok" })
    expect(calls).toBe(2)
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeGreaterThanOrEqual(0)
    expect(slept[0]).toBeLessThan(2_000)
  })

  test("retries exhaust after the bounded set (three), and the fourth failure still surfaces", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: "upstream trouble" } }), { status: 503 })
    }) as unknown as typeof globalThis.fetch
    const slept: Array<number> = []
    const layer = realInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      packagesInScope: "",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    await expect(
      Effect.runPromise(
        Effect.flatMap(Infer, (model) => model.react([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }])).pipe(
          Effect.provide(layer)
        ) as Effect.Effect<unknown>
      )
    ).rejects.toBeTruthy()
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
    const layer = realInfer({
      baseUrl: "https://model.test/v1",
      apiKey: "k",
      model: "test-model",
      packagesInScope: "",
      fetch: fetchImpl,
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      }
    })
    await expect(
      Effect.runPromise(
        Effect.flatMap(Infer, (model) => model.react([{ type: "MessageReceived", id: "m1", text: "go", at: 1 }])).pipe(
          Effect.provide(layer)
        ) as Effect.Effect<unknown>
      )
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
    expect(slept).toHaveLength(0)
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
