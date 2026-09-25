import { testModelData } from "../../testing/model"
import { messages } from "../messages"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { historyOf } from "../../model/execution/prompt"
import { renderMessages } from "../../projection/messages"
import { compact, contextPolicyOf, estimateTokens } from "./index"

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

for (const hidden of ["repaired", "failed", "unreferenced"] as const) {
  test(`${hidden}: evidence outside the projected context cannot affect compaction`, () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 10, max: 70 }), (size, retainPercent) => {
      const small = history(hidden, 0)
      const large = history(hidden, size)
      expect(renderMessages(large)).toEqual(renderMessages(small))
      expect(estimateTokens(large)).toBe(estimateTokens(small))
      const policy = { retainRatio: retainPercent / 100 }
      const machine = machineOf(compact(messages(), policy))
      const keys = (events: Event[]) => replayProjection(machine, events, testModelData).transitions.map(work => work.key)
      expect(keys(large)).toEqual(keys(small))
    }))
  })
}

for (const change of ["model", "provider"] as const) test(`${change} switches exclude reasoning from both the prompt and compaction`, () => {
  fc.assert(fc.property(fc.integer({ min: 1000, max: 10000 }), fc.boolean(), (size, resolved) => {
    const target = { provider: change === "provider" ? "other" : "fixture", model_id: change === "model" ? "other" : "fixture" }
    const events = (length: number): Event[] => {
      const log = history("unreferenced", 0)
      log[3] = { ...log[3]!, continuation: {
        protocol: "openai-responses", provider: "fixture", model: "fixture", endpoint: "https://fixture.invalid",
        payload: Schema.encodeSync(Prompt.Prompt)(Prompt.make([Prompt.assistantMessage({ content: [
          Prompt.makePart("reasoning", { text: "Think".repeat(length), options: { openai: { encryptedContent: "x".repeat(length) } } }),
          Prompt.makePart("text", { text: "Okay" })
        ] })]))
      } }
      log[log.length - 1] = { ...log.at(-1)!, attemptKey: "attempt" }
      log.push({ type: "MessageReceived", id: "next", text: "Continue", ...(resolved ? {} : { model: target }), at: 6 })
      if (resolved) log.push({ type: "ModelCalled", callId: "next-attempt", ordinal: 0, turn: "next", model: target, at: 7 })
      return log
    }
    const small = events(0)
    const large = events(size)
    const identity = { provider: target.provider, model: target.model_id, protocol: "openai-responses" }
    expect(historyOf(renderMessages(large), identity)).toEqual(historyOf(renderMessages(small), identity))
    expect(estimateTokens(large)).toBe(estimateTokens(small))
    const original = { provider: "fixture", model_id: "fixture" }
    expect(estimateTokens(large, {}, original)).toBeGreaterThan(estimateTokens(small, {}, original) + 200)
    const policy = { model: { provider: "summary", model_id: "summary" } }
    const machine = machineOf(compact(messages(), policy))
    const keys = (log: Event[]) => replayProjection(machine, log, testModelData).transitions.map(work => work.key)
    expect(keys(large)).toEqual(keys(small))
  }))
})


test("deprecated ratio aliases preserve thresholds and reject conflicting declarations", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 60, max: 99 }),
    fc.integer({ min: 1, max: 50 }),
    (window, triggerPercent, retainPercent) => {
      const triggerRatio = triggerPercent / 100
      const retainRatio = retainPercent / 100
      const current = { triggerRatio, retainRatio }
      const legacy = { fireRatio: triggerRatio, keepRatio: retainRatio }
      expect(contextPolicyOf(legacy, window)).toEqual(contextPolicyOf(current, window))
      expect(contextPolicyOf({ ...current, ...legacy }, window)).toEqual(contextPolicyOf(current, window))
      expect(() => contextPolicyOf({ ...current, fireRatio: triggerRatio / 2 }, window)).toThrow("triggerRatio conflicts")
      expect(() => contextPolicyOf({ ...current, keepRatio: retainRatio / 2 }, window)).toThrow("retainRatio conflicts")
    }
  ))
})

const roundSizes = fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 2, maxLength: 5 })
const conversations = fc.array(roundSizes, { minLength: 1, maxLength: 3 })

// conversation builds complete response groups with call IDs reused only across turns.
const conversation = (turns: ReadonlyArray<ReadonlyArray<number>>, size: number) => {
  const events: Event[] = []
  const boundaries = new Map<string, number>()
  const exchanges: Array<{ call: number; returned: number; group: number }> = []
  for (const [turnIndex, rounds] of turns.entries()) {
    const turn = `turn-${turnIndex}`
    boundaries.set(`m:${turn}`, events.length)
    events.push({ type: "MessageReceived", id: turn, text: "x".repeat(size), at: events.length })
    for (const [round, count] of rounds.entries()) {
      const group = events.length
      const responseId = `response-${turnIndex}-${round}`
      for (let call = 0; call < count; call++) {
        const callId = `${round}-${call}`
        if (call === 0) boundaries.set(`c:${JSON.stringify([turn, callId])}`, group)
        events.push({ type: "ToolCalled", turn, responseId, callId, name: "read", arguments: { text: "x".repeat(size) }, at: events.length })
      }
      for (let call = 0; call < count; call++) {
        exchanges.push({ call: group + call, returned: events.length, group })
        events.push({ type: "ToolReturned", transitionRef: { seq: group + call + 1, component: "tools", tag: "answer" }, turn, callId: `${round}-${call}`, result: "x".repeat(size), at: events.length })
      }
    }
    if (turnIndex < turns.length - 1) events.push({ type: "TurnCompleted", turn, output: "done", at: events.length })
  }
  return { events, boundaries, exchanges }
}

const summaryInput = Schema.Struct({ keepFrom: Schema.String, summary: Schema.String, keepTokens: Schema.Finite })

test("generated cuts preserve response groups and advance until no legal cut remains", () => {
  fc.assert(fc.property(conversations, fc.integer({ min: 1, max: 300 }), fc.integer({ min: 10, max: 70 }), (turns, size, retainPercent) => {
    const { events, boundaries, exchanges } = conversation(turns, size)
    const machine = machineOf(compact(messages(), { retainRatio: retainPercent / 100 }))
    let prior = 0
    let summary = ""
    let commits = 0
    while (true) {
      const output = replayProjection(machine, events, testModelData)
      expect(output.view.messages?.[0]?.checkpoint?.summary).toBe(summary)
      const work = output.transitions[0]
      if (work === undefined) {
        expect([...boundaries.values()].some(index => index > prior)).toBe(false)
        break
      }
      expect(output.transitions).toHaveLength(1)
      const input = Schema.decodeSync(summaryInput)(work.input)
      const cut = boundaries.get(input.keepFrom)
      expect(cut).toBeDefined()
      if (cut === undefined) throw new Error("Cut is not a generated boundary")
      expect(cut).toBeGreaterThan(prior)
      expect(input.summary).toBe(summary)
      for (const exchange of exchanges) {
        expect(exchange.call < cut).toBe(exchange.returned < cut)
        expect(exchange.call < cut).toBe(exchange.group < cut)
      }
      expect(input.keepTokens).toBe(Math.floor(estimateTokens(events) * (retainPercent / 100)))
      summary = `summary-${++commits}`
      events.push({ type: "CompactionCompleted", keepFrom: input.keepFrom, summary, at: events.length })
      prior = cut
      expect(commits).toBeLessThanOrEqual(boundaries.size)
    }
  }), { numRuns: 100 })
})

test("an unresolved response group withholds compaction until every call returns", () => {
  fc.assert(fc.property(roundSizes, fc.integer({ min: 1, max: 4 }), (rounds, pending) => {
    const { events } = conversation([rounds], 40)
    const machine = machineOf(compact(messages(), { retainRatio: 0.3 }))
    const start = events.length + 1
    for (let call = 0; call < pending; call++) events.push({
      type: "ToolCalled", turn: "turn-0", responseId: "pending", callId: `pending-${call}`, name: "read", arguments: {}, at: events.length
    })
    for (let call = 0; call < pending; call++) {
      expect(replayProjection(machine, events, testModelData).transitions).toEqual([])
      events.push({ type: "ToolReturned", transitionRef: { seq: start + call, component: "tools", tag: "answer" }, turn: "turn-0", callId: `pending-${call}`, result: "done", at: events.length })
    }
    expect(replayProjection(machine, events, testModelData).transitions).toHaveLength(1)
  }), { numRuns: 100 })
})
