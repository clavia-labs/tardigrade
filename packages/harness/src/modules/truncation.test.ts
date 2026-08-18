import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import { createAgent } from "../module"
import { inference } from "./inference"
import { truncationNudge } from "./truncation"

// The wording that asks a model for the rest of a cut answer. It lives here rather than in the
// renderer because the answer depends on the agent: prose continues, a tool call has to be made
// again, and an agent whose tools can append would say something else entirely.

const head: Event = { type: "MessageReceived", id: "m-1", text: "Write the addendum.", at: 1 }

const truncated = (fields: Partial<Event> = {}): Event => ({
  type: "AnswerTruncated",
  turn: "m-1",
  callId: "k-0",
  text: "The lease was signed on",
  tokens: 8192,
  at: 3,
  ...fields
})

const textOf = (log: ReadonlyArray<Event>) => {
  const agent = createAgent({
    modules: [inference({ contextWindow: 200_000 }), ...truncationNudge()]
  })
  return agent
    .request(log)
    .messages.filter((message) => message.role === "system")
    .map((message) => String(message.content))
}

describe("the truncation nudges", () => {
  test("ask a cut answer to continue from where it stopped", () => {
    const said = textOf([head, truncated()])
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("Continue from exactly where it stopped")
  })

  // A cut call never reached a tool, so there is nothing to continue and nothing to undo. Asking
  // the model to carry on from a fragment of JSON is what would produce a second broken call.
  test("ask a cut tool call to be made again, smaller", () => {
    const said = textOf([head, truncated({ text: "", tool: "write", arguments: `{"path":"a` })])
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("Make the call again")
    expect(said[0]).toContain("never dispatched")
  })

  test("say nothing once the answer moved on", () => {
    const dispatched: Event = {
      type: "ToolCalled",
      turn: "m-1",
      callId: "c-1",
      name: "write",
      arguments: {},
      at: 4
    }
    expect(textOf([head, truncated(), dispatched])).toEqual([])
    expect(textOf([head])).toEqual([])
  })

  test("take the wording a caller states", () => {
    const agent = createAgent({
      modules: [
        inference({ contextWindow: 200_000 }),
        ...truncationNudge({ continueText: "Keep going, but finish inside the budget." })
      ]
    })
    expect(
      agent
        .request([head, truncated()])
        .messages.filter((message) => message.role === "system")
        .map((message) => String(message.content))
    ).toEqual(["Keep going, but finish inside the budget."])
  })
})
