import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core"
import {
  replyView,
  servedLog,
  transcript,
  treeUsageIn,
  turnHead,
  turnOf,
  turnView,
  usageIn
} from "./turns"
import { spendOf, ZERO_USAGE, type Usage } from "./infer"

const message = (id: string, at: number): Event => ({ type: "MessageReceived", id, text: id, at })
const stamped = (type: string, turn: string, at: number): Event => ({ type, turn, at })

describe("turn attribution", () => {
  test("the current turn is the earliest message with no terminal", () => {
    const log = [message("m-1", 1), stamped("ToolCalled", "m-1", 2), message("m-2", 3)]
    expect(turnOf(log)).toBe("m-1")
    expect(turnHead(log)?.id).toBe("m-1")
  })

  test("a message that arrives mid-turn waits, unserved", () => {
    // Concurrent ingress: m-2 lands while m-1 is still running. The view holds only m-1.
    const log = [
      message("m-1", 1),
      message("m-2", 2),
      stamped("ModelCalled", "m-1", 3),
      stamped("ToolCalled", "m-1", 4)
    ]
    expect(turnView(log).map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ToolCalled"
    ])
    expect(turnView(log)[0]?.id).toBe("m-1")
  })

  test("the next turn heads the fold once the first one ends", () => {
    const log = [
      message("m-1", 1),
      message("m-2", 2),
      stamped("TurnCompleted", "m-1", 3)
    ]
    expect(turnOf(log)).toBe("m-2")
    expect(turnView(log)).toEqual([message("m-2", 2)])
  })

  test("attribution is a fact in the log, never a derivation from position", () => {
    // The events of two turns interleave in the log. Each view still holds only its own.
    const log = [
      message("m-1", 1),
      message("m-2", 2),
      stamped("ToolCalled", "m-2", 3),
      stamped("ToolCalled", "m-1", 4)
    ]
    expect(turnView(log).every((event) => event.turn === undefined || event.turn === "m-1")).toBe(true)
    expect(turnView(log)).toHaveLength(2)
  })

  test("an empty log folds to no turn at all", () => {
    expect(turnView([])).toEqual([])
    expect(turnOf([])).toBe("")
    expect(turnHead([])).toBeUndefined()
  })
})

describe("replyView", () => {
  test("lags one stage behind, so a queued turn never steals a reply", () => {
    const log = [
      message("m-1", 1),
      stamped("TurnCompleted", "m-1", 2),
      message("m-2", 3),
      stamped("ToolCalled", "m-2", 4)
    ]
    expect(replyView(log)[0]?.id).toBe("m-1")
    expect(turnOf(log)).toBe("m-2")
  })

  test("empties once the reply is recorded", () => {
    const log = [
      message("m-1", 1),
      stamped("TurnCompleted", "m-1", 2),
      stamped("ReplyDelivered", "m-1", 3)
    ]
    expect(replyView(log)).toEqual([])
  })
})

describe("servedLog", () => {
  test("puts each head just before its first stamped event and drops the queued ones", () => {
    const log = [
      message("m-1", 1),
      message("m-2", 2),
      stamped("ToolCalled", "m-1", 3),
      stamped("TurnCompleted", "m-1", 4)
    ]
    expect(servedLog(log).map((event) => event.type)).toEqual([
      "MessageReceived",
      "ToolCalled",
      "TurnCompleted",
      "MessageReceived"
    ])
    // m-2 rides at the end because it is the current turn and has served nothing yet.
    expect(servedLog(log)[3]?.id).toBe("m-2")
  })

  test("passes unstamped events through in place", () => {
    const log = [
      message("m-1", 1),
      stamped("TurnCompleted", "m-1", 2),
      { type: "CompactionCompleted", upTo: 2, summary: "s", at: 3 }
    ]
    expect(servedLog(log).map((event) => event.type)).toEqual([
      "MessageReceived",
      "TurnCompleted",
      "CompactionCompleted"
    ])
  })
})

describe("usageIn", () => {
  test("sums what one turn spent on the model", () => {
    const log: ReadonlyArray<Event> = [
      message("m-1", 1),
      {
        type: "ModelReturned",
        turn: "m-1",
        callId: "k-0",
        usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.001 },
        at: 2
      },
      {
        type: "ModelReturned",
        turn: "m-1",
        callId: "k-1",
        usage: { promptTokens: 200, completionTokens: 20, costUsd: 0.002 },
        at: 3
      },
      {
        type: "ModelReturned",
        turn: "m-2",
        callId: "k-0",
        usage: { promptTokens: 999, completionTokens: 99, costUsd: 9 },
        at: 4
      }
    ]
    expect(usageIn(log, "m-1")).toEqual(spendOf(
      { promptTokens: 300, completionTokens: 30, costUsd: 0.003 },
      ZERO_USAGE
    ))
  })

  test("reads zero from a turn that never called the model", () => {
    expect(usageIn([message("m-1", 1)], "m-1")).toEqual(spendOf(ZERO_USAGE, ZERO_USAGE))
  })

  test("an in-flight call is unsettled, using the reservation ModelCalled carried", () => {
    const log: ReadonlyArray<Event> = [
      message("m-1", 1),
      {
        type: "ModelCalled",
        turn: "m-1",
        callId: "k-0",
        reserved: { promptTokens: 80, completionTokens: 0, costUsd: 0.002 },
        at: 2
      }
    ]
    expect(usageIn(log, "m-1")).toEqual(
      spendOf(ZERO_USAGE, { promptTokens: 80, completionTokens: 0, costUsd: 0.002 })
    )
  })

  test("an orphaned call that settled without a result stays unsettled", () => {
    const log: ReadonlyArray<Event> = [
      message("m-1", 1),
      {
        type: "ModelCalled",
        turn: "m-1",
        callId: "k-0",
        reserved: { promptTokens: 80, completionTokens: 0, costUsd: 0.002 },
        at: 2
      },
      {
        type: "ModelSettled",
        turn: "m-1",
        callId: "k-0",
        usage: { promptTokens: 80, completionTokens: 0, costUsd: 0.002 },
        reason: "the model attempt died",
        at: 3
      }
    ]
    expect(usageIn(log, "m-1")).toEqual(
      spendOf(ZERO_USAGE, { promptTokens: 80, completionTokens: 0, costUsd: 0.002 })
    )
  })

  test("a provider that omitted cost is unknown, and a reported zero is free", () => {
    const log: ReadonlyArray<Event> = [
      message("m-1", 1),
      {
        type: "ModelReturned",
        turn: "m-1",
        callId: "k-0",
        usage: { promptTokens: 10, completionTokens: 4 },
        at: 2
      },
      {
        type: "ModelReturned",
        turn: "m-2",
        callId: "k-0",
        usage: { promptTokens: 10, completionTokens: 4, costUsd: 0 },
        at: 3
      }
    ]
    expect(usageIn(log, "m-1").costUsd).toBeUndefined()
    expect(usageIn(log, "m-2").costUsd).toBe(0)
  })
})

describe("treeUsageIn", () => {
  const spent = (promptTokens: number, completionTokens: number, costUsd: number): Usage => ({
    promptTokens,
    completionTokens,
    costUsd
  })

  // Reporting usage is the whole contract. A sub-agent reports its own tree, and so does any other
  // tool that reached a model, including a script that delegated from inside a sandbox.
  const log: ReadonlyArray<Event> = [
    message("m-1", 1),
    { type: "ModelReturned", turn: "m-1", callId: "k-0", usage: spent(10, 5, 0.01), at: 2 },
    {
      type: "ToolReturned",
      turn: "m-1",
      callId: "c-1",
      result: { agent: "worker/1", usage: spent(4, 2, 0.004) },
      at: 3
    },
    {
      type: "ToolReturned",
      turn: "m-1",
      callId: "c-2",
      result: { value: "done", usage: spent(1, 1, 0.002) },
      at: 4
    },
    { type: "ToolReturned", turn: "m-1", callId: "c-3", result: { rows: 12 }, at: 5 },
    { type: "ToolReturned", turn: "m-1", callId: "c-4", result: null, at: 6 },
    { type: "ModelReturned", turn: "m-2", callId: "k-0", usage: spent(999, 99, 9), at: 7 }
  ]

  test("folds in every tool result that reports spend", () => {
    expect(treeUsageIn(log, "m-1")).toEqual(spendOf(spent(15, 8, 0.016), ZERO_USAGE))
  })

  test("leaves a tool that spent nothing out of the total", () => {
    expect(usageIn(log, "m-1")).toEqual(spendOf(spent(10, 5, 0.01), ZERO_USAGE))
  })

  test("reads zero from a turn with nothing recorded", () => {
    expect(treeUsageIn(log, "m-9")).toEqual(spendOf(ZERO_USAGE, ZERO_USAGE))
  })
})

describe("transcript", () => {
  test("renders the columns Observability documents", () => {
    const log: ReadonlyArray<Event> = [
      {
        type: "MessageReceived",
        id: "m-1",
        text: "Find the invoice for order 4182.",
        agent: "sha256:9f2c…",
        at: 1
      },
      { type: "ModelCalled", turn: "t-1", callId: "c-01", at: 2 },
      {
        type: "ModelReturned",
        turn: "t-1",
        callId: "c-01",
        usage: { promptTokens: 1284, completionTokens: 96, costUsd: 0.0041 },
        at: 3
      },
      {
        type: "ToolCalled",
        turn: "t-1",
        callId: "c-02",
        name: "lookup_invoice",
        arguments: { orderId: "4182" },
        at: 4
      },
      {
        type: "ToolReturned",
        turn: "t-1",
        callId: "c-02",
        result: { invoice: "INV-4182", total: "312.00" },
        at: 5
      },
      { type: "BudgetExhausted", turn: "t-1", budget: 1, used: 1, at: 6 },
      { type: "TurnCompleted", turn: "t-1", output: "Invoice INV-4182 totals 312.00.", at: 7 },
      { type: "ReplyDelivered", turn: "t-1", at: 8 }
    ]
    expect(transcript(log)).toBe(
      [
        ` 1  MessageReceived   m-1   "Find the invoice for order 4182."   agent=sha256:9f2c…`,
        ` 2  ModelCalled       t-1   c-01`,
        ` 3  ModelReturned     t-1   c-01   1284 in / 96 out / $0.0041`,
        ` 4  ToolCalled        t-1   c-02   lookup_invoice {"orderId":"4182"}`,
        ` 5  ToolReturned      t-1   c-02   {"invoice":"INV-4182","total":"312.00"}`,
        ` 6  BudgetExhausted   t-1   budget=1 used=1`,
        ` 7  TurnCompleted     t-1   "Invoice INV-4182 totals 312.00."`,
        ` 8  ReplyDelivered    t-1`
      ].join("\n")
    )
  })

  test("keeps a separator when the framework's own call ids run past the column", () => {
    // The inference module mints `${turn}/infer/${n}`, so a real call id is eleven characters and
    // the documented seven-character column can not hold it. A column that ran into the next value
    // would read as a call id of "m-1/infer/0108".
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m-1", text: "Find it.", agent: "sha256:9f2c…", at: 1 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 2 },
      {
        type: "ModelReturned",
        turn: "m-1",
        callId: "m-1/infer/0",
        usage: { promptTokens: 108, completionTokens: 32, costUsd: 0.0013 },
        at: 3
      },
      { type: "ReplyDelivered", turn: "m-1", at: 4 }
    ]
    expect(transcript(log)).toBe(
      [
        ` 1  MessageReceived   m-1   "Find it."   agent=sha256:9f2c…`,
        ` 2  ModelCalled       m-1   m-1/infer/0`,
        ` 3  ModelReturned     m-1   m-1/infer/0   108 in / 32 out / $0.0013`,
        ` 4  ReplyDelivered    m-1`
      ].join("\n")
    )
  })

  test("widens every column to the widest value present", () => {
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "conversation-9", text: "hi", at: 1 },
      { type: "CompactionCompleted", upTo: 1, provider: "naive", summary: "s", at: 2 },
      { type: "ToolCalled", turn: "conversation-9", callId: "toolu_01A", name: "t", arguments: {}, at: 3 }
    ]
    // "CompactionCompleted" is the widest type and "conversation-9" the widest id, so the type
    // column is 22 and the id column 17, and every line's detail starts in the same place.
    expect(transcript(log)).toBe(
      [
        ` 1  MessageReceived       conversation-9   "hi"   agent=`,
        ` 2  CompactionCompleted                    upTo=1 provider=naive "s"`,
        ` 3  ToolCalled            conversation-9   toolu_01A   t {}`
      ].join("\n")
    )
    // Every value keeps its separator: no column ever abuts the next.
    for (const line of transcript(log).split("\n")) {
      expect(line).not.toMatch(/(conversation-9|toolu_01A|Completed)\S/)
    }
  })

  test("prints the facts of an event type it never met", () => {
    expect(transcript([{ type: "HandoffAccepted", turn: "t-1", operator: "ada", at: 1 }])).toBe(
      ` 1  HandoffAccepted   t-1   {"operator":"ada"}`
    )
  })
})
