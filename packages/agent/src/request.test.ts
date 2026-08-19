import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { trajectoryOf } from "@clavia/tardigrade-code/turns"
import { modelRequest, renderMessages } from "./request"
import { codeMode, renderOf, toolList } from "./capability"

const CODE = renderOf([codeMode], [])

// The request is a pure projection of the trajectory: the message conversation, and the tool and
// prompt policy. Both live in the domain, so they test without a provider.

describe("renderMessages", () => {
  test("a full turn renders as user, assistant tool call, tool result", () => {
    const trajectory: ReadonlyArray<Event> = [
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

  test("a checkpoint survives the projection: identity anchors the same event in log and render", () => {
    // A queued mid-turn message shifts every raw index by one once the projection excludes it. An
    // index checkpoint would slice the render one event late and open it with a dangling tool
    // result; the identity finds ToolCalled c2 wherever the projection put it.
    const raw: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "draft the addendum", at: 0 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 1, turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: { code: "read" }, turn: "m1", at: 2 },
      { type: "ToolReturned", callId: "c1", result: { ok: 1 }, turn: "m1", at: 3 },
      { type: "MessageReceived", id: "m2", text: "queued follow-up", at: 4 },
      { type: "ToolCalled", callId: "c2", name: "execute", arguments: { code: "write" }, turn: "m1", at: 5 },
      { type: "ToolReturned", callId: "c2", result: { ok: 2 }, turn: "m1", at: 6 },
      { type: "CompactionCompleted", keepFrom: "c:c2", summary: "read the base contract", at: 7 }
    ]
    const messages = renderMessages(trajectoryOf(raw))
    expect(messages[0]).toMatchObject({ role: "user", content: "draft the addendum" }) // the open head, verbatim
    expect(String(messages[1]!.content)).toContain("read the base contract")
    expect(messages[2]).toMatchObject({ role: "assistant", toolCalls: [{ id: "c2", name: "execute" }] })
    expect(messages[3]).toMatchObject({ role: "tool", toolCallId: "c2" })
    expect(messages).toHaveLength(4)
  })

  test("a head at the cut renders once, never verbatim and again from the suffix", () => {
    const raw: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "old task", at: 0 },
      { type: "TurnCompleted", output: "done", turn: "m1", at: 1 },
      { type: "ReplyDelivered", turn: "m1", at: 2 },
      { type: "MessageReceived", id: "m2", text: "new task", at: 3 },
      { type: "ModelCalled", callId: "m2/infer/0", ordinal: 1, turn: "m2", at: 4 },
      { type: "CompactionCompleted", keepFrom: "m:m2", summary: "the old task finished", at: 5 }
    ]
    const messages = renderMessages(trajectoryOf(raw))
    expect(messages.map((m) => m.role)).toEqual(["user", "user"])
    expect(String(messages[0]!.content)).toContain("Summary of earlier work")
    expect(messages[1]).toMatchObject({ content: "new task" })
  })

  test("the truncation caps are the consumer's, and the render says where it cut", () => {
    const trajectory: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "y".repeat(50), at: 0 },
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: {}, turn: "m1", at: 1 },
      { type: "ToolReturned", callId: "c1", result: "z".repeat(50), turn: "m1", at: 2 }
    ]
    const tight = renderMessages(trajectory, { messageRenderCap: 10, resultRenderCap: 10 })
    expect(String(tight[0]!.content)).toContain("truncated at 10 of 50 chars")
    expect(String(tight[2]!.content)).toContain("truncated at 10 of 52 chars")
    // The default caps are far above this trajectory, so nothing truncates.
    const whole = renderMessages(trajectory)
    expect(whole[0]!.content).toBe("y".repeat(50))
  })
})

describe("modelRequest tool and prompt policy", () => {
  const head = (extra: Event[] = [], output?: unknown): Event[] => [
    { type: "MessageReceived", id: "m1", text: "go", ...(output === undefined ? {} : { output }), at: 0 },
    ...extra
  ]

  test("with no schema, offers execute; with a schema, offers execute and answer", () => {
    expect(modelRequest(head(), CODE).tools.map((t) => t.name)).toEqual(["execute"])
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(modelRequest(head([], schema), CODE).tools.map((t) => t.name)).toEqual(["execute", "answer"])
  })

  test("once the budget is spent, execute is dropped and the nudge is added", () => {
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }])
    const req = modelRequest(spent, CODE)
    expect(req.tools.map((t) => t.name)).toEqual([]) // no work tool, no schema, so the model answers in prose
    expect(req.system).toContain("tool budget for this turn is spent")
  })

  test("spent with a schema leaves only the answer tool", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }], schema)
    expect(modelRequest(spent, CODE).tools.map((t) => t.name)).toEqual(["answer"])
  })

  test("a spent wall from an earlier turn does not drop execute in a fresh turn", () => {
    const trajectory: Event[] = [
      { type: "MessageReceived", id: "m1", text: "old", at: 0 },
      { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 1 },
      { type: "TurnCompleted", output: "done", turn: "m1", at: 2 },
      { type: "MessageReceived", id: "m2", text: "new", at: 3 }
    ]
    expect(modelRequest(trajectory, CODE).tools.map((t) => t.name)).toEqual(["execute"])
  })
})

describe("the tool surface decides the tool table", () => {
  const LAB = renderOf(
    [
      toolList([
        { spec: { name: "read", description: "read a file", inputSchema: {} }, run: () => Effect.succeed("") },
        { spec: { name: "grep", description: "search files", inputSchema: {} }, run: () => Effect.succeed("") }
      ])
    ],
    []
  )
  const head = (extra: Event[] = [], output?: unknown): Event[] => [
    { type: "MessageReceived", id: "m1", text: "go", ...(output === undefined ? {} : { output }), at: 0 },
    ...extra
  ]

  test("a native surface offers its own tools and never mentions execute", () => {
    const req = modelRequest(head(), LAB)
    expect(req.tools.map((t) => t.name)).toEqual(["read", "grep"])
    expect(req.system).not.toContain("execute")
    expect(req.system).toContain("read, grep")
  })

  test("every policy still folds over a swapped surface", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(modelRequest(head([], schema), LAB).tools.map((t) => t.name)).toEqual(["read", "grep", "answer"])
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }], schema)
    // The wall drops the work tools whatever they are, and leaves the answer contract standing.
    expect(modelRequest(spent, LAB).tools.map((t) => t.name)).toEqual(["answer"])
    expect(modelRequest(spent, LAB).system).toContain("tool budget for this turn is spent")
  })

  test("the turn frame is surface independent", () => {
    for (const surface of [CODE, LAB]) {
      expect(modelRequest(head(), surface).system).toContain("that reply is your final answer")
    }
  })
})
