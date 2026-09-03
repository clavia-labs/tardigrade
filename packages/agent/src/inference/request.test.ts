import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { trajectoryOf } from "@clavia/tardigrade-code/execution/turns"
import { modelRequest } from "./request"
import { messagesProjection, renderMessages } from "../projection/messages"
import { budget, canonicalOf, codeMode, nativeOutput, output, outputRepairFor, renderOf, tool } from "../index"

// One declared contract, used wherever a turn needs one.
const SCOUT = output({
  name: "scout",
  schema: {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false
  }
})

const CODE = renderOf([codeMode(), nativeOutput], [])
const budgetedCode = (log: ReadonlyArray<Event>) => renderOf([budget([codeMode()]), nativeOutput], log)

// The request is a pure projection of the trajectory: the message conversation, and the tool and
// prompt policy. Both live in the domain, so they test without a provider.

describe("renderMessages", () => {
  test("the projection matches complete replay at every prefix", () => {
    const events: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "inspect it", at: 0 },
      { type: "TextReturned", text: "checking", turn: "m1", at: 1 },
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: { code: "return 1" }, turn: "m1", at: 1 },
      { type: "ToolReturned", callId: "c1", result: { value: 1 }, turn: "m1", at: 2 },
      { type: "TurnCompleted", output: "done", turn: "m1", at: 3 }
    ]
    const projection = messagesProjection()
    let state = projection.initial()
    for (let index = 0; index < events.length; index++) {
      state = projection.step(state, events[index]!)
      expect(projection.output(state)).toEqual(renderMessages(events.slice(0, index + 1)))
    }
  })

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

  test("terminal reports disclose local settlement", () => {
    for (const outcome of ["completed", "failed"] as const) {
      const messages = renderMessages([
        { type: "MessageReceived", id: "run-worker.reply", text: "world built", outcome, at: 0 }
      ])
      expect(messages[0]).toEqual({
        role: "user",
        content: `[Terminal report: ${outcome}. Your answer to this report stays in this thread and is not sent back to its sender.]\nworld built`
      })
    }
  })

})

describe("modelRequest tool and prompt policy", () => {
  const head = (extra: Event[] = [], declared = false): Event[] => [
    { type: "MessageReceived", id: "m1", text: "go", ...(declared ? { output: { name: SCOUT.name, schema: SCOUT.schema } } : {}), at: 0 },
    ...extra
  ]

  test("a contract is never a tool, a tool choice, or a sentence in the prompt", () => {
    expect(modelRequest(head(), CODE).tools.map((t) => t.name)).toEqual(["execute"])
    const req = modelRequest(head([], true), CODE)
    expect(req.tools.map((t) => t.name)).toEqual(["execute"])
    expect(req.output?.kind).toBe("contract")
    expect(req.output?.kind === "contract" && canonicalOf(req.output.contract)).toBe(canonicalOf(SCOUT))
    // Nothing is mounted, so the request declares no fallback at all.
    expect(req.output?.kind === "contract" && req.output.fallback).toBeUndefined()
    expect(req.output?.kind === "contract" && req.output.fallbackSystem).toBeUndefined()
    expect(req.system).not.toContain("scout")
    expect(req.system).not.toContain("schema")
  })

  test("the frame never mentions the contract, declared or not", () => {
    for (const declared of [false, true]) {
      expect(modelRequest(head([], declared), CODE).system).toContain("that reply is your final answer")
    }
  })

  // A mounted fallback is a policy for a call native output cannot serve, and it stays dormant
  // otherwise: its instruction rides the output request rather than the base prompt, so the
  // binding decides whether the model ever reads it (platform/model/src/output/contract.ts, outputSystemFor).
  test("a mounted fallback rides the request, and adds nothing to the base prompt", () => {
    const bare = modelRequest(head([], true), CODE)
    const repaired = renderOf([codeMode(), outputRepairFor({ attempts: 1 })], head([], true))
    const req = modelRequest(head([], true), repaired)
    expect(req.output?.kind === "contract" && req.output.fallback).toEqual({
      kind: "repair",
      name: "repair",
      attempts: 1,
      projectHistory: true
    })
    expect(req.output?.kind === "contract" && req.output.fallbackSystem).toContain('conforming to the schema "scout"')
    // Mounting it changed neither the prompt nor the conversation.
    expect(req.system).toBe(bare.system)
    expect(req.system).not.toContain("scout")
    expect(req.messages).toEqual(bare.messages)
  })

  test("once the budget is spent, execute is dropped and the nudge is added", () => {
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }])
    const req = modelRequest(spent, budgetedCode(spent))
    expect(req.tools.map((t) => t.name)).toEqual([])
    expect(req.system).toContain("tool budget for this turn is spent")
  })

  test("the wall drops the work tools and leaves the contract standing", () => {
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }], true)
    const req = modelRequest(spent, budgetedCode(spent))
    expect(req.tools.map((t) => t.name)).toEqual([])
    expect(req.output?.kind === "contract" && req.output.contract.name).toBe("scout")
  })

  test("a spent wall from an earlier turn does not drop execute in a fresh turn", () => {
    const trajectory: Event[] = [
      { type: "MessageReceived", id: "m1", text: "old", at: 0 },
      { type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 1 },
      { type: "TurnCompleted", output: "done", turn: "m1", at: 2 },
      { type: "MessageReceived", id: "m2", text: "new", at: 3 }
    ]
    expect(modelRequest(trajectory, budgetedCode(trajectory)).tools.map((t) => t.name)).toEqual(["execute"])
  })

  // A declaration nobody can serve rides the request as a verdict rather than as an absence: a
  // request with no output reads as a turn that wanted prose, and this one wanted something else
  // (output.ts, DeclaredOutput; platform/model/src/output/contract.ts, outputPreflight).
  test("an output declaration that is not a contract rides the request as invalid", () => {
    const raw: Event[] = [{ type: "MessageReceived", id: "m1", text: "go", output: { type: "object" }, at: 0 }]
    const req = modelRequest(raw, CODE)
    expect(req.output?.kind).toBe("invalid")
    expect(req.output?.kind === "invalid" && req.output.errors.join(" ")).toContain("is not a contract")
  })
})

describe("the repair exchange in the render", () => {
  const repair = (projectHistory: boolean) => ({
    kind: "repair" as const,
    name: "repair",
    attempts: 2,
    projectHistory
  })
  const rejection = (turn: string, at: number, projectHistory = true): Event => ({
    type: "OutputRejected",
    contract: "scout",
    attempt: `${turn}/infer/0`,
    text: '{"a":1}',
    errors: ["/a: expected string"],
    mode: repair(projectHistory),
    turn,
    at
  })

  test("an owed correction renders as the reply and the framework's reasons", () => {
    const trajectory: Event[] = [{ type: "MessageReceived", id: "m1", text: "go", at: 0 }, rejection("m1", 1)]
    const messages = renderMessages(trajectory)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(messages[1]!.content).toBe('{"a":1}')
    expect(String(messages[2]!.content)).toContain("/a: expected string")
  })

  // The generic correction sentence belongs to the framework loop alone. A component that mounts
  // a delegated implementation decides its own feedback, and nothing is written on its behalf
  // (output.ts, OutputFallback; inference/machine.ts, openRejection).
  test("a delegated implementation writes its own feedback, and the framework writes none", () => {
    const delegated: Event = {
      type: "OutputRejected",
      contract: "scout",
      attempt: "m1/infer/0",
      text: '{"a":1}',
      errors: ["/a: expected string"],
      mode: { kind: "delegated", name: "house-style", projectHistory: true },
      turn: "m1",
      at: 1
    }
    const owed = renderMessages([{ type: "MessageReceived", id: "m1", text: "go", at: 0 }, delegated])
    // Nobody has decided yet, so the rejected reply stands alone with no framework sentence.
    expect(owed.map((m) => m.role)).toEqual(["user", "assistant"])
    const decided = renderMessages([
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      delegated,
      {
        type: "OutputRetryRequested",
        rejection: "m1/infer/0",
        feedback: "House style: dates are ISO 8601.",
        by: "house-style",
        turn: "m1",
        at: 2
      }
    ])
    expect(decided.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(decided[2]!.content).toBe("House style: dates are ISO 8601.")
    expect(String(decided[2]!.content)).not.toContain("Reply again with JSON")
  })

  test("a corrected exchange compacts out of the render, and stays in the log", () => {
    const trajectory: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      rejection("m1", 1),
      { type: "TurnCompleted", output: '{"a":"one"}', turn: "m1", at: 2 },
      { type: "MessageReceived", id: "m2", text: "next", at: 3 }
    ]
    // The turn reads as though the model answered correctly the first time.
    expect(renderMessages(trajectory).map((m) => m.content)).toEqual(["go", '{"a":"one"}', "next"])
    // The rejection is still a fact of the log; only the render dropped it.
    expect(trajectory.some((e) => e.type === "OutputRejected")).toBe(true)
  })

  // The projection reads the policy recorded on the rejection, so what an old turn means cannot
  // change when a deployment mounts a different one (projection/transcript.ts, projectedOutput).
  test("a rejection recorded under a policy that keeps history keeps rendering", () => {
    const trajectory: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      rejection("m1", 1, false),
      { type: "TurnCompleted", output: '{"a":"one"}', turn: "m1", at: 2 }
    ]
    expect(renderMessages(trajectory).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  test("a failed turn keeps its rejection: it is what explains the failure", () => {
    const trajectory: Event[] = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      rejection("m1", 1),
      { type: "TurnFailed", error: "spent", turn: "m1", at: 2 }
    ]
    expect(renderMessages(trajectory).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })
})

describe("the tool surface decides the tool table", () => {
  const lab = tool([
    { spec: { name: "read", description: "read a file", inputSchema: {} }, run: () => Effect.succeed("") },
    { spec: { name: "grep", description: "search files", inputSchema: {} }, run: () => Effect.succeed("") }
  ])
  const LAB = renderOf([lab, nativeOutput], [])
  const budgetedLab = (log: ReadonlyArray<Event>) => renderOf([budget([lab]), nativeOutput], log)
  const head = (extra: Event[] = [], declared = false): Event[] => [
    { type: "MessageReceived", id: "m1", text: "go", ...(declared ? { output: { name: SCOUT.name, schema: SCOUT.schema } } : {}), at: 0 },
    ...extra
  ]

  test("a native surface offers its own tools and never mentions execute", () => {
    const req = modelRequest(head(), LAB)
    expect(req.tools.map((t) => t.name)).toEqual(["read", "grep"])
    expect(req.system).not.toContain("execute")
    expect(req.system).toContain("read, grep")
  })

  test("every policy still folds over a swapped surface", () => {
    expect(modelRequest(head([], true), LAB).tools.map((t) => t.name)).toEqual(["read", "grep"])
    const spent = head([{ type: "BudgetExhausted", budget: 2, used: 3, turn: "m1", at: 5 }], true)
    // The wall drops the work tools whatever they are, and leaves the contract standing.
    const spentReq = modelRequest(spent, budgetedLab(spent))
    expect(spentReq.tools.map((t) => t.name)).toEqual([])
    expect(spentReq.output?.kind === "contract" && spentReq.output.contract.name).toBe("scout")
    expect(spentReq.system).toContain("tool budget for this turn is spent")
  })

  test("the turn frame is surface independent", () => {
    for (const surface of [CODE, LAB]) {
      expect(modelRequest(head(), surface).system).toContain("that reply is your final answer")
    }
  })
})
