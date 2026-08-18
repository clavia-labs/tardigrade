import { describe, expect, test } from "bun:test"
import type { Envelope } from "@flamecast/core/envelope"
import { modelRequest, renderMessages } from "./request"

// The request is a pure projection of the trajectory: the message conversation, and the tool and
// prompt policy. Both live in the domain, so they test without a provider.

describe("renderMessages", () => {
  test("a full turn renders as user, assistant tool call, tool result", () => {
    const trajectory: ReadonlyArray<Envelope> = [
      { type: "MessageReceived", id: "m1", text: "add the JD", at: 1 },
      { type: "ModelCalled", callId: "m1/infer/0", at: 2 },
      { type: "TextReturned", text: "adding it now", at: 3 },
      { type: "ToolCalled", callId: "call_1", name: "execute", arguments: { code: "return 1" }, at: 3 },
      { type: "CodeDispatched", execId: "call_1", code: "return 1", at: 4 },
      { type: "ToolReturned", callId: "call_1", result: { result: 1 }, at: 5 }
    ]
    const messages = renderMessages(trajectory)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
    // The domain shape keeps the raw tool name; the platform sanitizes for its wire.
    expect(messages[1]).toMatchObject({
      content: "adding it now",
      toolCalls: [{ id: "call_1", name: "execute", arguments: '{"code":"return 1"}' }]
    })
    expect(messages[2]).toMatchObject({ toolCallId: "call_1", content: '{"result":1}' })
  })
})

describe("modelRequest tool and prompt policy", () => {
  const head = (extra: Envelope[] = [], output?: unknown): Envelope[] => [
    { type: "MessageReceived", id: "m1", text: "go", ...(output === undefined ? {} : { output }), at: 0 },
    ...extra
  ]

  test("with no schema, offers execute; with a schema, offers execute and answer", () => {
    expect(modelRequest(head(), undefined as never).tools.map((t) => t.name)).toEqual(["execute"])
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(modelRequest(head([], schema), "").tools.map((t) => t.name)).toEqual(["execute", "answer"])
  })

  test("once the budget is spent, execute is dropped and the nudge is added", () => {
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }])
    const req = modelRequest(spent, "")
    expect(req.tools.map((t) => t.name)).toEqual([]) // no work tool, no schema, so the model answers in prose
    expect(req.system).toContain("tool budget for this turn is spent")
  })

  test("spent with a schema leaves only the answer tool", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }], schema)
    expect(modelRequest(spent, "").tools.map((t) => t.name)).toEqual(["answer"])
  })

  test("a spent wall from an earlier turn does not drop execute in a fresh turn", () => {
    const trajectory: Envelope[] = [
      { type: "MessageReceived", id: "m1", text: "old", at: 0 },
      { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 1 },
      { type: "TurnCompleted", output: "done", turn: "m1", at: 2 },
      { type: "MessageReceived", id: "m2", text: "new", at: 3 }
    ]
    expect(modelRequest(trajectory, "").tools.map((t) => t.name)).toEqual(["execute"])
  })
})
