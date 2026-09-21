import { expect, test } from "bun:test"
import * as fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { renderMessageEntries, renderMessages } from "./messages"

const text = fc.string({ minLength: 1, maxLength: 80 })
const turn = fc.record({
  rounds: fc.array(fc.option(text, { nil: undefined }), { minLength: 1, maxLength: 4 }),
  partial: text,
  terminal: fc.constantFrom("TurnCompleted", "TurnFailed", "TurnCancelled"),
  spacing: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 24, maxLength: 24 })
})

test("interleaving turns preserves their messages and event order", () => {
  fc.assert(fc.property(fc.array(turn, { minLength: 2, maxLength: 6 }), (turns) => {
    const histories = turns.map(({ rounds, partial, terminal, spacing }, index) => {
      const id = `turn-${index}`
      const events: Event[] = [{ type: "MessageReceived", id, text: id, at: 0 }]
      rounds.forEach((prose, round) => {
        const callId = `${id}/tool/${round}`
        events.push({ type: "ModelCalled", turn: id, callId: `${id}/infer/${round}`, at: 0 })
        if (prose !== undefined) events.push({ type: "TextReturned", turn: id, text: prose, at: 0 })
        events.push(
          { type: "ToolCalled", turn: id, callId, name: "read", arguments: {}, at: 0 },
          { type: "ToolReturned", turn: id, callId, result: round, at: 0 }
        )
      })
      events.push(
        { type: "TextReturned", turn: id, text: partial, at: 0 },
        { type: terminal, turn: id, output: "done", error: "failed", at: 0 }
      )
      let at = 0
      return events.map((event, position) => ({ ...event, at: at += spacing[position]! }))
    })
    const interleaved = histories.flat().sort((a, b) => Number(a.at) - Number(b.at))
    const order = new Map<Event, number>(interleaved.map((event, index) => [event, index]))
    const expected = histories.flatMap((events) => renderMessageEntries(events))
      .sort((a, b) => order.get(a.event)! - order.get(b.event)!)
    expect(renderMessageEntries(interleaved)).toEqual(expected)
  }))
})

test("cancellation preserves the latest partial once and leaves the next tool call without prose", () => {
  fc.assert(fc.property(fc.array(text, { minLength: 1, maxLength: 8 }), (partials) => {
    const messages = renderMessages([
      { type: "MessageReceived", id: "cancelled", text: "Read", at: 0 },
      ...partials.map((text, index) => ({ type: "TextReturned", turn: "cancelled", text, at: index + 1 })),
      { type: "TurnCancelled", turn: "cancelled", at: 10 },
      { type: "MessageReceived", id: "next", text: "Calculate", at: 11 },
      { type: "ToolCalled", turn: "next", callId: "calculate", name: "calculate", arguments: {}, at: 12 }
    ])
    expect(messages).toEqual([
      { role: "user", content: "Read" },
      { role: "assistant", content: partials.at(-1)! },
      { role: "user", content: "Calculate" },
      { role: "assistant", content: null, toolCalls: [{ id: "calculate", name: "calculate", arguments: "{}" }] }
    ])
  }))
})
