import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import { createAgent, customInference, inference } from "@flamecast/harness"
import { modelCallPrefixes, observationOf, observationallyEquivalent } from "./observe"

const head: ReadonlyArray<Event> = [
  { type: "MessageReceived", id: "m-1", text: "What are your hours?", at: 1 }
]

describe("finite program observations", () => {
  test("captures rendered requests, machine folds, and injected projections", () => {
    const agent = createAgent({ modules: [inference({ contextWindow: 200_000 })] })
    const observation = observationOf(agent, head)
    expect(observation.request.messages).toEqual([
      { role: "user", content: "What are your hours?" }
    ])
    expect(observation.machines.map((machine) => machine.id)).toEqual(["inference", "reply"])
    expect(observation.projections["flamecast/InferenceStateProjection"]).toMatchObject({
      provider: "vercel-ai-gateway"
    })
  })

  test("treats two constructions with the same behavior as equivalent on a corpus", () => {
    const left = createAgent({ modules: [inference({ contextWindow: 200_000 })] })
    const right = createAgent({ modules: [inference({ contextWindow: 200_000 })] })
    expect(observationallyEquivalent(left, right, [[], head])).toBe(true)
  })

  test("finds a prompt change on the first relevant log", () => {
    const left = createAgent({ modules: [inference({ system: "Answer clearly.", contextWindow: 200_000 })] })
    const right = createAgent({ modules: [inference({ system: "Answer briefly.", contextWindow: 200_000 })] })
    expect(observationallyEquivalent(left, right, [[], head])).toBe(false)
  })

  test("finds model-state changes even before a request is sent", () => {
    const narrow = customInference(async () => ({ kind: "complete", output: "ok" }), {
      id: "narrow",
      contextWindow: 8_000
    })
    const wide = customInference(async () => ({ kind: "complete", output: "ok" }), {
      id: "wide",
      contextWindow: 200_000
    })
    const left = createAgent({ modules: [inference({ provider: narrow })] })
    const right = createAgent({ modules: [inference({ provider: wide })] })
    expect(observationallyEquivalent(left, right, [[]])).toBe(false)
  })

  test("extracts the exact prefixes that produced recorded model calls", () => {
    const log: ReadonlyArray<Event> = [
      ...head,
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 2 },
      { type: "ModelReturned", turn: "m-1", callId: "m-1/infer/0", at: 3 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/1", at: 4 }
    ]
    expect(modelCallPrefixes(log)).toEqual([log.slice(0, 1), log.slice(0, 3)])
  })
})
