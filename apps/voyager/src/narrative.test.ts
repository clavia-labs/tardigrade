import { describe, expect, test } from "bun:test"

import type { Event, EventRow } from "./api"
import {
  clockOf,
  fieldsOf,
  FOLDED,
  instantOf,
  merged,
  momentsOf,
  spanOf,
  stampOf,
  summaryOf,
  TIME_FIELDS,
  truncate
} from "./narrative"

// The event list's decisions that are pure: what a row says, what an opened row lists, what its
// stamp is colored, which events fold into a duration rather than render, and how two readings of
// one log fold together.

const at = 1

describe("summaryOf", () => {
  const cases: ReadonlyArray<readonly [Event, string]> = [
    [{ type: "MessageReceived", id: "m1", text: "spawn survey", at }, "spawn survey"],
    [
      { type: "MessageReceived", id: "survey.0.reply", text: "ok", outcome: "completed", from: "bun:ag.survey.0", at },
      "reply · outcome: completed · from bun:ag.survey.0"
    ],
    [{ type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at }, "attempt 2 · m1"],
    [{ type: "TextReturned", text: "thinking it over", at }, "thinking it over"],
    [
      { type: "ToolCalled", callId: "survey", name: "execute", arguments: { code: "const a = 1\nreturn a" }, at },
      "execute · const a = 1 return a"
    ],
    [{ type: "ToolReturned", callId: "survey", result: { result: [1] }, at }, 'survey · {"result":[1]}'],
    [{ type: "CodeDispatched", execId: "survey", code: "one\ntwo\nthree", at }, "survey · 3 lines"],
    [{ type: "CodeDispatched", execId: "solo", code: "return 1", at }, "solo · 1 line"],
    [
      { type: "PackageCalled", callId: "survey.0", name: "agents.run", arguments: { text: "shard 1" }, at },
      'agents.run · {"text":"shard 1"}'
    ],
    [{ type: "BlockedOn", callId: "survey.0", awaiting: "survey.0.reply", at }, "awaiting survey.0.reply"],
    [{ type: "TurnCompleted", output: "the answer", at }, "the answer"],
    [{ type: "TurnFailed", error: "no mind", cause: "inference_error", at }, "inference_error · no mind"],
    [{ type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at }, "m1 · epoch 0 to 1"],
    [{ type: "ReplyDelivered", turn: "m1", to: "bun:ag.root", at }, "to bun:ag.root"],
    [{ type: "ReplyDelivered", turn: "m1", at }, "no replyTo"],
    [{ type: "BudgetExhausted", budget: 40, used: 41, at }, "used 41 of 40"],
    [{ type: "BudgetRequested", callId: "b1", reason: "one more shard", amount: 10, at }, "asks 10 · one more shard"],
    [{ type: "BudgetGranted", amount: 10, at }, "granted 10"],
    [{ type: "BudgetDenied", reason: "the run is over budget", at }, "the run is over budget"],
    [{ type: "CompactionCompleted", keepFrom: "m2", summary: "surveyed three shards", at }, "keep from m2 · surveyed three shards"]
  ]

  for (const [event, expected] of cases) {
    test(`${event.type} reads as one line`, () => {
      expect(summaryOf(event)).toBe(expected)
    })
  }

  test("a type the app has never seen renders its field names", () => {
    expect(summaryOf({ type: "SomethingNew", weight: 3, colour: "moss" } as Event)).toBe("weight, colour")
  })

  test("a summary is cut at the stated length", () => {
    const event: Event = { type: "TurnCompleted", output: "x".repeat(2000), at }
    expect(summaryOf(event, 10)).toBe(`${"x".repeat(9)}…`)
  })
})

describe("truncate", () => {
  test("a shorter line survives whole", () => {
    expect(truncate("  two   words ", 40)).toBe("two words")
  })
})

describe("stampOf", () => {
  test("the four the mock names keep their voices", () => {
    expect(stampOf("MessageReceived")).toEqual({ fg: "var(--ink-2)", bg: "var(--sunken)" })
    expect(stampOf("CodeDispatched")).toEqual({ fg: "var(--run)", bg: "var(--run-wash)" })
    expect(stampOf("PackageCalled")).toEqual({ fg: "var(--wait)", bg: "var(--wait-wash)" })
    expect(stampOf("TurnCompleted")).toEqual({ fg: "var(--ok)", bg: "var(--ok-wash)" })
  })

  test("a failure is the rust and an unknown type is neutral", () => {
    expect(stampOf("TurnFailed").fg).toBe("var(--fail)")
    expect(stampOf("SomethingNew")).toEqual(stampOf("MessageReceived"))
  })
})

describe("spanOf", () => {
  test("one unit per ladder step", () => {
    expect(spanOf(0)).toBe("0ms")
    expect(spanOf(940)).toBe("940ms")
    expect(spanOf(58_000)).toBe("58s")
    expect(spanOf(24 * 60_000)).toBe("24m")
    expect(spanOf(3 * 3_600_000)).toBe("3h")
  })
})

describe("clockOf", () => {
  test("an instant reads as the hours and minutes on the reader's own clock", () => {
    expect(clockOf(new Date(2024, 0, 1, 14, 2).getTime())).toBe("14:02")
  })
})

describe("instantOf", () => {
  test("an expanded instant carries the second and the millisecond", () => {
    expect(instantOf(new Date(2024, 0, 1, 14, 2, 11, 480).getTime())).toBe("14:02:11.480")
  })

  test("every part is padded, so the column stays one width", () => {
    expect(instantOf(new Date(2024, 0, 1, 9, 5, 3, 7).getTime())).toBe("09:05:03.007")
  })
})

const stamped = new Date(2024, 0, 1, 14, 2, 11, 480).getTime()
const keysOf = (event: Event) => fieldsOf(event).map((field) => field.key)

describe("fieldsOf", () => {
  test("a message lists its id and its instant, and drops the text the row already is", () => {
    expect(fieldsOf({ type: "MessageReceived", id: "m1", text: "spawn survey", at: stamped })).toEqual([
      { key: "id", value: "m1", kind: "text" },
      { key: "at", value: "14:02:11.480", kind: "text" }
    ])
  })

  test("a text the row had to cut is kept whole, because the cut line is not the value", () => {
    const text = "x".repeat(500)
    const fields = fieldsOf({ type: "MessageReceived", id: "m1", text, at: stamped })
    expect(fields.map((field) => field.key)).toEqual(["id", "at", "text"])
    expect(fields[2]?.value).toBe(text)
  })

  test("a reply leads with the ids that correlate it", () => {
    const event: Event = {
      type: "MessageReceived",
      id: "survey.0.reply",
      text: "ok",
      outcome: "completed",
      from: "bun:ag.survey.0",
      at: stamped
    }
    expect(keysOf(event)).toEqual(["id", "from", "outcome", "at", "text"])
  })

  test("only a dispatched code body sits in the well", () => {
    const event: Event = { type: "CodeDispatched", execId: "survey", code: "const a = 1\nreturn a", at: stamped }
    expect(fieldsOf(event)).toEqual([
      { key: "execId", value: "survey", kind: "text" },
      { key: "at", value: "14:02:11.480", kind: "text" },
      { key: "code", value: "const a = 1\nreturn a", kind: "code" }
    ])
  })

  test("a code body carried as a tool argument is a payload, not a well", () => {
    const event: Event = {
      type: "ToolCalled",
      callId: "survey",
      name: "execute",
      arguments: { code: "return 1" },
      at: stamped
    }
    expect(fieldsOf(event).map((field) => [field.key, field.kind])).toEqual([
      ["callId", "text"],
      ["name", "text"],
      ["at", "text"],
      ["arguments", "text"]
    ])
  })

  test("an object renders as compact JSON on one line while it fits", () => {
    const event: Event = { type: "PackageCalled", callId: "t1.0", name: "agents.run", arguments: { text: "shard 1" }, at: stamped }
    expect(fieldsOf(event).at(-1)).toEqual({ key: "arguments", value: '{"text":"shard 1"}', kind: "text" })
  })

  test("an object past the inline length is indented in the same cell", () => {
    const event: Event = { type: "ToolReturned", callId: "t1", result: { text: "y".repeat(40) }, at: stamped }
    expect(fieldsOf(event, 20).at(-1)?.value).toBe(`{\n  "text": "${"y".repeat(40)}"\n}`)
  })

  test("a type the app has never seen lists its own keys in insertion order", () => {
    expect(keysOf({ type: "SomethingNew", weight: 3, colour: "moss", at: stamped } as Event)).toEqual([
      "weight",
      "colour",
      "at"
    ])
  })

  test("a field a type's order does not name still renders, after the ones it does", () => {
    const event: Event = { type: "TurnCompleted", turn: "m1", output: "two\nlines", at: stamped, lane: "agent" }
    expect(keysOf(event)).toEqual(["turn", "at", "output", "lane"])
  })

  test("an output the row states verbatim is the row's line and not a field of its own", () => {
    expect(keysOf({ type: "TurnCompleted", turn: "m1", output: "done", at: stamped })).toEqual(["turn", "at"])
  })

  test("an absent optional is not a field, and the instant is the only clock", () => {
    expect(keysOf({ type: "ReplyDelivered", turn: "m1", to: undefined, at: stamped })).toEqual(["turn", "at"])
    expect(TIME_FIELDS).toEqual(["at"])
  })

  test("a number and a null read as themselves", () => {
    const event: Event = { type: "BudgetExhausted", budget: 40, used: 41, turn: null as unknown as string, at: stamped }
    expect(fieldsOf(event).map((field) => field.value)).toEqual(["40", "41", "null", "14:02:11.480"])
  })

  test("the host's own stamp sits between the event's ids and its payload", () => {
    const event: Event = {
      type: "CodeDispatched",
      execId: "survey",
      code: "return 1",
      turn: "m1",
      traceparent: "00-abc-def-01",
      at: stamped
    }
    expect(keysOf(event)).toEqual(["execId", "turn", "traceparent", "at", "code"])
  })
})

const row = (seq: number, event: Event): EventRow => ({ seq, event })

const minute = 60_000
const start = new Date(2024, 0, 1, 14, 0).getTime()

describe("momentsOf", () => {
  const log: ReadonlyArray<EventRow> = [
    row(1, { type: "MessageReceived", id: "m1", text: "go", at: start }),
    row(2, { type: "CodeDispatched", execId: "t1", code: "x", at: start + minute }),
    row(3, { type: "PackageCalled", callId: "t1.0", name: "agents.run", arguments: {}, at: start + 2 * minute }),
    row(4, { type: "PackageReturned", callId: "t1.0", result: {}, at: start + 5 * minute }),
    row(5, { type: "CodeSettled", execId: "t1", result: 1, at: start + 6 * minute }),
    row(6, { type: "PackageCalled", callId: "t1.1", name: "agents.run", arguments: {}, at: start + 7 * minute }),
    row(7, { type: "TurnCompleted", turn: "m1", output: "done", at: start + 10 * minute })
  ]

  test("the ends of a pair fold away and every other event renders", () => {
    expect(momentsOf(log).map((moment) => [moment.seq, moment.event.type])).toEqual([
      [1, "MessageReceived"],
      [2, "CodeDispatched"],
      [3, "PackageCalled"],
      [6, "PackageCalled"],
      [7, "TurnCompleted"]
    ])
    expect(FOLDED).toEqual(["CodeSettled", "PackageReturned"])
  })

  test("a dispatch spans to its settle, a call to its return, and a turn back to its message", () => {
    expect(momentsOf(log).map((moment) => moment.duration)).toEqual([undefined, "5m", "3m", undefined, "10m"])
  })

  test("a seq the screen has not seen yet leaves the row with a time and no span", () => {
    const open = momentsOf([log[0]!, log[1]!])
    expect(open[1]?.duration).toBeUndefined()
    expect(open[1]?.time).toBe("14:01")
  })

  test("an event with no timestamp still renders", () => {
    const moments = momentsOf([row(1, { type: "TextReturned", text: "hm" })])
    expect(moments[0]?.time).toBe("")
    expect(moments[0]?.summary).toBe("hm")
  })
})

describe("merged", () => {
  test("a redelivered seq lands once and the log stays in order", () => {
    const held = [row(1, { type: "A" }), row(2, { type: "B" })]
    const next = merged(held, [row(2, { type: "B" }), row(3, { type: "C" })])
    expect(next.map((each) => each.seq)).toEqual([1, 2, 3])
  })
})
