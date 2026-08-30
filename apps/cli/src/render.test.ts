import { describe, expect, test } from "bun:test"
import type { ThreadSummary, EventRow } from "@clavia/tardigrade-client"

import { threadsTable, ABSENT, DEFAULT_DETAIL_WIDTH, ELLIPSIS, eventsTable, methodLines, methodsLines, table } from "./render"

// The human rendering. A table is plain aligned text, so these assert on columns rather than on
// escape sequences, and a value the projection did not carry reads as absent rather than as empty.

const threads: ReadonlyArray<ThreadSummary> = [
  { id: "root", depth: 0, events: 12, lastAt: 0, status: "settled" },
  { id: "root.1", parent: "root", depth: 1, events: 3, status: "running" }
]

describe("table", () => {
  test("columns are padded to the widest cell and the last is not", () => {
    const lines = table(["A", "BB"], [["x", "y"], ["longer", "z"]]).split("\n")
    expect(lines).toEqual(["A       BB", "x       y", "longer  z"])
  })
})

describe("threadsTable", () => {
  test("a run is one row, and an absent field reads as absent", () => {
    const lines = threadsTable(threads).split("\n")
    expect(lines[0]).toContain("THREAD")
    expect(lines[1]).toContain("root")
    expect(lines[1]).toContain("settled")
    expect(lines[2]).toContain("1")
    expect(lines[1]).toContain("1970-01-01T00:00:00.000Z")
    expect(lines[1]).toContain(ABSENT)
    expect(lines[2]).toContain("root.1")
  })

  test("an empty store says so", () => {
    expect(threadsTable([])).toBe("no threads")
  })
})

describe("eventsTable", () => {
  const rows: ReadonlyArray<EventRow> = [
    { seq: 7, event: { type: "MessageReceived", id: "m1", text: "hello" } },
    { seq: 8, event: { type: "Settled" } }
  ]

  test("one line per event, carrying its sequence number", () => {
    const lines = eventsTable(rows).split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("7")
    expect(lines[1]).toContain("MessageReceived")
    expect(lines[1]).toContain("\"text\":\"hello\"")
    expect(lines[2]).toContain("Settled")
  })

  test("a detail wider than the column is cut and marked", () => {
    const wide: EventRow = { seq: 1, event: { type: "ToolReturned", result: "x".repeat(DEFAULT_DETAIL_WIDTH * 2) } }
    const line = eventsTable([wide]).split("\n")[1] ?? ""
    expect(line).toContain(ELLIPSIS)
    expect(line.length).toBeLessThan(DEFAULT_DETAIL_WIDTH * 2)
  })

  test("a stated width is the width", () => {
    const wide: EventRow = { seq: 1, event: { type: "T", result: "x".repeat(50) } }
    const line = eventsTable([wide], 20).split("\n")[1] ?? ""
    expect(line.endsWith(ELLIPSIS)).toBe(true)
  })

  test("an empty log says so", () => {
    expect(eventsTable([])).toBe("no events")
  })
})

describe("methodLines", () => {
  test("a completed call prints its output under its handle", () => {
    expect(methodLines("root", "m1", { status: "completed", output: "ok" })).toBe("root m1 completed\nok")
  })

  test("a failed call prints its error", () => {
    expect(methodLines("root", "m1", { status: "failed", error: "no model" })).toBe("root m1 failed\nno model")
  })

  test("a pending call is its handle alone", () => {
    expect(methodLines("root", "m1", { status: "pending" })).toBe("root m1 pending")
  })

})

describe("methodsLines", () => {
  test("shows the root schemas for a method", () => {
    expect(methodsLines([{
      name: "message",
      cancellable: true,
      timeoutMs: 300_000,
      inputSchema: { type: "object", required: ["text"] },
      outputSchema: { type: "string" }
    }])).toBe(
      "message\n  cancellable yes\n  timeout 300000ms\n  input  {\"type\":\"object\",\"required\":[\"text\"]}\n  output {\"type\":\"string\"}"
    )
  })

  test("an actor with no methods says so", () => {
    expect(methodsLines([])).toBe("no methods")
  })
})
