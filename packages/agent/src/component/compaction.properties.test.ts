import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { eventAt } from "@clavia/tardigrade-core/event"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { historyOf } from "../binding/prompt"
import { renderMessages } from "../projection/messages"
import { compaction, compactionReactor, estimateTokens } from "./compaction"

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
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 40, max: 400 }), (size, contextWindowTokens) => {
      const small = history(hidden, 0)
      const large = history(hidden, size)
      expect(renderMessages(large)).toEqual(renderMessages(small))
      expect(estimateTokens(large)).toBe(estimateTokens(small))
      const policy = { contextWindowTokens }
      const reactor = compactionReactor(policy)
      const machine = compaction(policy).machine
      const keys = (events: Event[]) => ({
        full: reactor(events).map((transition) => transition.key),
        incremental: machine.output(events.reduce((state, event, index) => machine.step(state, eventAt(event, index + 1)), machine.initial())).transitions.map((transition) => transition.key)
      })
      expect(keys(large)).toEqual(keys(small))
      expect(keys(large).incremental).toEqual(keys(large).full)
    }))
  })
}

test("visible continuation growth still contributes to the context estimate", () => {
  const small = history("unreferenced", 0)
  const large = history("unreferenced", 4_000)
  small[small.length - 1] = { ...small.at(-1)!, attemptKey: "attempt" }
  large[large.length - 1] = { ...large.at(-1)!, attemptKey: "attempt" }
  expect(renderMessages(large).at(-1)?.continuation).toBeDefined()
  expect(estimateTokens(large)).toBeGreaterThan(estimateTokens(small) + 900)
})

test("complete and incremental accounting retain the open request across a checkpoint", () => {
  const events: Event[] = [
    { type: "MessageReceived", id: "turn", text: "x".repeat(400), at: 0 },
    { type: "ToolCalled", turn: "turn", callId: "a", name: "read", arguments: {}, at: 1 },
    { type: "ToolReturned", turn: "turn", callId: "a", result: "ok", at: 2 },
    { type: "CompactionCompleted", keepFrom: 'c:["turn","a"]', summary: "Earlier work", at: 3 },
    { type: "ToolCalled", turn: "turn", callId: "b", name: "read", arguments: {}, at: 4 },
    { type: "ToolReturned", turn: "turn", callId: "b", result: "ok", at: 5 }
  ]
  const policy = { contextWindowTokens: 125 }
  const machine = compaction(policy).machine
  let state = machine.initial()
  for (let i = 0; i < events.length; i++) {
    state = machine.step(state, eventAt(events[i]!, i + 1))
    expect(machine.output(state).transitions.map((transition) => transition.key))
      .toEqual(compactionReactor(policy)(events.slice(0, i + 1)).map((transition) => transition.key))
  }
})

test("KEEP rounds the cumulative rendered size", () => {
  const events: Event[] = [{ type: "MessageReceived", id: "turn", text: "x", at: 0 }]
  for (let index = 0; index < 100; index++) {
    events.push(
      { type: "ToolCalled", turn: "turn", callId: String(index), name: "x", arguments: {}, at: index * 2 + 1 },
      { type: "ToolReturned", turn: "turn", callId: String(index), result: "x", at: index * 2 + 2 }
    )
  }
  const transition = compactionReactor({ contextWindowTokens: 100, fireRatio: 0.8, keepRatio: 0.5 })(events)[0]
  expect(transition).toBeDefined()
  const input = (transition as unknown as { readonly input: { readonly keepFrom: string } }).input
  const keptAt = events.findIndex((event) =>
    event.type === "ToolCalled" && `c:${JSON.stringify([event.turn ?? null, event.callId])}` === input.keepFrom
  )
  expect(estimateTokens(events.slice(keptAt))).toBeLessThanOrEqual(50)
  expect(estimateTokens(events.slice(keptAt - 1))).toBeGreaterThan(50)
})

for (const change of ["model", "provider"] as const) test(`${change} switches exclude opaque state from both the prompt and compaction`, () => {
  fc.assert(fc.property(fc.integer({ min: 1000, max: 10000 }), fc.boolean(), (size, resolved) => {
    const target = { provider: change === "provider" ? "other" : "fixture", model_id: change === "model" ? "other" : "fixture" }
    const events = (length: number): Event[] => {
      const log = history("unreferenced", 0)
      log[3] = { ...log[3]!, continuation: {
        protocol: "openai-responses", provider: "fixture", model: "fixture", endpoint: "https://fixture.invalid",
        payload: Schema.encodeSync(Prompt.Prompt)(Prompt.make([Prompt.assistantMessage({ content: [
          Prompt.makePart("reasoning", { text: "Think", options: { openai: { encryptedContent: "x".repeat(length) } } }),
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
    const policy = { contextWindowTokens: 100 }
    const machine = compaction(policy).machine
    const keys = (log: Event[]) => machine.output(log.reduce((state, event, i) => machine.step(state, eventAt(event, i + 1)), machine.initial())).transitions.map((transition) => transition.key)
    expect(keys(large)).toEqual(keys(small))
    expect(keys(large)).toEqual(compactionReactor(policy)(large).map((transition) => transition.key))
  }))
})
