import { testModelData, testModelLock } from "../../testing/model"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { messages } from "../messages"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { renderMessages } from "../../projection/messages"
import { describe, expect, test } from "bun:test"
import { Prompt } from "effect/unstable/ai"
import { Context, Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { compact, compactionReactor, contextPolicyOf, estimateTokens, keepFromIndex, suffixOf } from "./index"

const head: Event = { type: "MessageReceived", id: "m0", text: "extract the covenants", at: 0 }
const TEST_POLICY = { contextWindowTokens: 20_000, fireRatio: 0.8, keepRatio: 0.2 }
const TEST_CONTEXT = contextPolicyOf(TEST_POLICY, TEST_POLICY.contextWindowTokens)
const reactor = compactionReactor(TEST_POLICY, testModelLock())

// One resolved tool round inside the open turn, sized so a dozen rounds cross the token budget.
const round = (i: number, turn = "m0", position = i * 2): Event[] => [
  { type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: { code: `run ${i}` }, turn, at: i * 2 + 1 },
  { type: "ToolReturned", transitionRef: { seq: position, component: "tools", tag: "answer" }, callId: `c${i}`, result: { data: "x".repeat(5_000) }, turn, at: i * 2 + 2 }
]

const openTurn = (rounds: number): Event[] => {
  const log: Event[] = [head]
  for (let i = 1; i <= rounds; i++) log.push(...round(i))
  return log
}

describe("the compaction measure and guard", () => {
  test("the measure counts what a render sends: capped results, skipped threads", () => {
    const big: Event = { type: "ToolReturned", callId: "c", result: { data: "x".repeat(40_000) }, at: 1 }
    expect(estimateTokens([big])).toBe(Math.ceil(renderMessages([big])[0]!.content!.length / 4))
    const thread: Event = { type: "CodeSettled", execId: "c", result: 1, at: 2 } as Event
    expect(estimateTokens([thread])).toBe(0)
    expect(estimateTokens([big], { resultRenderCap: 40 })).toBe(Math.ceil(renderMessages([big], { resultRenderCap: 40 })[0]!.content!.length / 4))
  })

  test("uses the consumer's file estimate alongside text without reading objects", () => {
    const file = {
      type: "file", mediaType: "application/pdf",
      object: { algorithm: "sha256", digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }
    }
    const events = [{ type: "MessageReceived", id: "files", content: [{ type: "text", text: "Read" }, file, file], at: 0 }]
    expect(estimateTokens(events, { fileTokens: 123 })).toBe(247)
    expect(estimateTokens(events, contextPolicyOf({ fileTokens: 200 }, 20_000))).toBe(401)
  })

  test("resolved rounds offer compaction without a trigger threshold", () => {
    expect(estimateTokens(suffixOf(openTurn(16)))).toBeGreaterThan(TEST_CONTEXT.fireTokens)
    expect(reactor(openTurn(16))).toHaveLength(1) // no reply anywhere, the turn is live
    expect(reactor(openTurn(2))).toHaveLength(1)
  })

  test("the keep line must remain below the fire line", () => {
    expect(() => contextPolicyOf({ keepRatio: 0.9, fireRatio: 0.8 }, 100)).toThrow("retainRatio must be less than triggerRatio")
  })

  test("the guard is pure: the fold runs with the clock and randomness rigged to throw", () => {
    const realNow = Date.now
    const realRandom = Math.random
    Date.now = () => {
      throw new Error("clock in the compaction guard")
    }
    Math.random = () => {
      throw new Error("random in the compaction guard")
    }
    try {
      expect(reactor(openTurn(16))).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })
})

test("a compaction checkpoint distinguishes reused provider IDs across turns", () => {
  const events: ReadonlyArray<Event> = [
    { type: "ToolCalled", turn: "first", callId: "7" },
    { type: "ToolReturned", turn: "first", callId: "7", result: "old" },
    { type: "ToolCalled", turn: "second", callId: "7" },
    { type: "ToolReturned", turn: "second", callId: "7", result: "new" }
  ]
  expect(keepFromIndex(events, `c:${JSON.stringify(["second", "7"])}`)).toBe(2)
})


describe("compact conversation views", () => {
  test("compaction offers work without deciding when inference needs it", () => {
    const history = openTurn(16)
    const output = replayProjection(machineOf(compact(messages(), { retainRatio: 0.2 })), history, testModelData)
    expect(output.transitions).toHaveLength(1)
    expect(output.view.messages?.[0]).toMatchObject({ ready: true, compaction: { proposals: output.transitions.map(work => work.key) } })
    expect(output.view.messages?.[0]?.context.contextWindowTokens).toBeUndefined()
    expect(Object.keys(output.interactions!)).toEqual(["cancel"])
  })

  test("committing a summary advances the next proposal and transforms the view", () => {
    const history = openTurn(16)
    const child = compact(messages(), TEST_POLICY)
    expect(replayProjection(machineOf(child), history, testModelData).transitions).toHaveLength(1)
    const after = replayProjection(machineOf(child), [...history, {
      type: "CompactionCompleted", summary: "Earlier work.", keepFrom: `c:${JSON.stringify(["m0", "c15"])}`, at: 100
    }], testModelData)
    expect(after.transitions.map(work => work.key)).not.toEqual(replayProjection(machineOf(child), history, testModelData).transitions.map(work => work.key))
    expect(after.view.messages?.[0]).toMatchObject({ ready: true, checkpoint: { summary: "Earlier work." } })
  })


})

test("a disallowed summary model fails before work is exposed", () => {
  const lock = testModelLock(() => { throw new Error("summary model is not allowed") })
  const child = compact(messages(), TEST_POLICY)
  expect(() => replayProjection(machineOf(child), openTurn(16), Context.make(ModelLock, lock)))
    .toThrow("summary model is not allowed")
})

test.each([0, -1, 1, NaN, Infinity])("compact rejects invalid retainRatio (%s)", ratio => {
  expect(() => compact(messages(), { retainRatio: ratio })).toThrow("retainRatio")
})
describe("a projected repair is invisible to compaction as well as to the render", () => {
  const REPAIR = { kind: "repair", name: "repair", attempts: 2, projectHistory: true }
  const rejected = (turn: string, at: number, implementation: unknown = REPAIR): Event => ({
    type: "OutputRejected",
    contract: "scout",
    attempt: `${turn}/infer/0`,
    text: "x".repeat(4_000),
    errors: ["/a: expected string"],
    mode: implementation,
    turn,
    at
  })

  test("the measure counts an owed correction and drops a corrected one", () => {
    const owed: ReadonlyArray<Event> = [rejected("m1", 1)]
    expect(estimateTokens(owed)).toBeGreaterThan(900)
    const corrected: ReadonlyArray<Event> = [rejected("m1", 1), { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }]
    expect(estimateTokens(corrected)).toBeLessThan(10)
    // A policy that keeps history keeps its weight too.
    const kept: ReadonlyArray<Event> = [
      rejected("m1", 1, { kind: "repair", name: "repair", attempts: 2, projectHistory: false }),
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }
    ]
    expect(estimateTokens(kept)).toBeGreaterThan(900)
  })

})

const history = (hidden: "repaired" | "failed" | "unreferenced", size: number): Event[] => [
  { type: "MessageReceived", id: "before", text: "Remember this", at: 0 },
  { type: "TurnCompleted", turn: "before", output: "Okay", at: 1 },
  { type: "MessageReceived", id: "turn", text: "Answer", at: 2 },
  { type: "ModelReturned", callId: "attempt", ordinal: 0, turn: "turn", outcome: hidden === "failed" ? "failed" : "returned", usage: {}, continuation: {
    protocol: "openai-responses", provider: "fixture", model: "fixture", endpoint: "https://fixture.invalid",
    payload: Schema.encodeSync(Prompt.Prompt)(Prompt.make([Prompt.assistantMessage({ content: [Prompt.makePart("text", { text: "x".repeat(size) })] })]))
  }, at: 3 },
  ...(hidden === "repaired" ? [{ type: "OutputRejected", attempt: "attempt", turn: "turn", text: "invalid", errors: ["wrong"], mode: { kind: "repair", name: "repair", attempts: 2, projectHistory: true }, at: 4 }] : []),
  hidden === "failed" ? { type: "TurnFailed", turn: "turn", error: { message: "failed" }, at: 5 } : { type: "TurnCompleted", turn: "turn", attemptKey: "other", output: "Okay", at: 5 }
]

test("visible continuation growth still contributes to the context estimate", () => {
  const small = history("unreferenced", 0)
  const large = history("unreferenced", 4_000)
  small[small.length - 1] = { ...small.at(-1)!, attemptKey: "attempt" }
  large[large.length - 1] = { ...large.at(-1)!, attemptKey: "attempt" }
  expect(renderMessages(large).at(-1)?.continuation).toBeDefined()
  expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small) + 900)
})

test("KEEP rounds the cumulative rendered size", () => {
  const events: Event[] = [{ type: "MessageReceived", id: "turn", text: "x", at: 0 }]
  for (let index = 0; index < 100; index++) {
    events.push(
      { type: "ToolCalled", turn: "turn", callId: String(index), name: "x", arguments: {}, at: index * 2 + 1 },
      { type: "ToolReturned", transitionRef: { seq: index * 2 + 2, component: "tools", tag: "answer" }, turn: "turn", callId: String(index), result: "x", at: index * 2 + 2 }
    )
  }
  const transition = compactionReactor({ keepRatio: 0.5 }, testModelLock())(events)[0]
  expect(transition).toBeDefined()
  const input = (transition as unknown as { readonly input: { readonly keepFrom: string } }).input
  const keptAt = events.findIndex((event) =>
    event.type === "ToolCalled" && `c:${JSON.stringify([event.turn ?? null, event.callId])}` === input.keepFrom
  )
  const keepTokens = Math.floor(estimateTokens(events) * 0.5)
  expect(estimateTokens(events.slice(keptAt))).toBeLessThanOrEqual(keepTokens)
  expect(estimateTokens(events.slice(keptAt - 1))).toBeGreaterThan(keepTokens)
})


test.each([0, -1, 1, NaN, Infinity])("compact rejects invalid triggerRatio (%s)", ratio => {
  expect(() => compact(messages(), { triggerRatio: ratio })).toThrow("triggerRatio")
})
