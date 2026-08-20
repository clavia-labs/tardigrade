import { describe, expect, test } from "bun:test"

import type { EventRow } from "@clavia/tardigrade-client"
import { momentsOf } from "./narrative"
import { DEFAULT_WINDOW_EVENTS, WINDOW_MIN_GAP } from "./policy"
import { axisOf, bucketsOf, copyTextOf, defaultWindowOf, moved, shownIn } from "./window"

// The window's decisions that are pure: where the axis runs, how dense each bucket is, which range
// the brush opens on, what a handle a drag pushed lands on, and what the copied window reads as.

const minute = 60_000
const start = Date.UTC(2026, 0, 1, 14, 0, 0)

const log = (count: number, spacing = minute): ReadonlyArray<EventRow> =>
  Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    event: { type: "TextReturned", text: `line ${index}`, at: start + index * spacing }
  }))

describe("bucketsOf", () => {
  test("a bucket counts the events whose instant falls in its slice", () => {
    const moments = momentsOf(log(4))
    expect(bucketsOf(moments, axisOf(moments), 3)).toEqual([1, 1, 2])
  })

  test("a burst stands above the quiet stretches around it", () => {
    const rows: ReadonlyArray<EventRow> = [
      { seq: 1, event: { type: "TextReturned", at: start } },
      ...Array.from({ length: 8 }, (_, index) => ({
        seq: index + 2,
        event: { type: "TextReturned", at: start + 5 * minute + index * 1000 }
      })),
      { seq: 10, event: { type: "TextReturned", at: start + 10 * minute } }
    ]
    const moments = momentsOf(rows)
    const buckets = bucketsOf(moments, axisOf(moments), 4)
    expect(buckets).toEqual([1, 0, 8, 1])
    expect(buckets.reduce((sum, count) => sum + count, 0)).toBe(moments.length)
  })

  test("a log of one instant has no span and still divides", () => {
    const moments = momentsOf(log(3, 0))
    expect(bucketsOf(moments, axisOf(moments), 2)).toEqual([3, 0])
  })
})

describe("defaultWindowOf", () => {
  test("a log no longer than the default opens whole", () => {
    const moments = momentsOf(log(DEFAULT_WINDOW_EVENTS))
    expect(defaultWindowOf(moments)).toEqual({ from: 0, to: 1 })
  })

  test("a longer log opens on its last events, and the window holds exactly those", () => {
    const moments = momentsOf(log(DEFAULT_WINDOW_EVENTS + 20))
    const window = defaultWindowOf(moments)
    expect(window.to).toBe(1)
    expect(window.from).toBeGreaterThan(0)
    expect(shownIn(moments, axisOf(moments), window)).toHaveLength(DEFAULT_WINDOW_EVENTS)
  })

  test("the count is the caller's to state", () => {
    const moments = momentsOf(log(10))
    expect(shownIn(moments, axisOf(moments), defaultWindowOf(moments, 4))).toHaveLength(4)
  })
})

describe("shownIn", () => {
  test("an event the host stamped no clock on is never hidden", () => {
    const moments = momentsOf([...log(4), { seq: 5, event: { type: "TextReturned", text: "no clock" } }])
    const shown = shownIn(moments, axisOf(moments), { from: 0, to: 0.1 })
    expect(shown.map((moment) => moment.seq)).toEqual([1, 5])
  })
})

describe("moved", () => {
  test("a handle stops at the track's ends", () => {
    expect(moved({ from: 0.2, to: 1 }, "from", -3)).toEqual({ from: 0, to: 1 })
    expect(moved({ from: 0, to: 0.5 }, "to", 4)).toEqual({ from: 0, to: 1 })
  })

  test("the handles cannot cross and keep the stated gap", () => {
    expect(moved({ from: 0.2, to: 0.5 }, "from", 0.9)).toEqual({ from: 0.5 - WINDOW_MIN_GAP, to: 0.5 })
    expect(moved({ from: 0.2, to: 0.5 }, "to", 0)).toEqual({ from: 0.2, to: 0.2 + WINDOW_MIN_GAP })
  })
})

describe("copyTextOf", () => {
  test("one line per event: the clock, the type, and the line the row shows", () => {
    const moments = momentsOf([
      { seq: 1, event: { type: "TextReturned", text: "thinking it over", at: start } },
      { seq: 2, event: { type: "BlockedOn", callId: "t1.0", awaiting: "t1.0.reply", at: start + minute } }
    ])
    expect(copyTextOf(moments, 12).split("\n")).toEqual([
      `${moments[0]?.time}  TextReturned  thinking it over`,
      `${moments[1]?.time}  BlockedOn     awaiting t1.0.reply`
    ])
  })

  test("an empty window copies as an empty string", () => {
    expect(copyTextOf([])).toBe("")
  })
})
