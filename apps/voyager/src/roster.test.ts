import { describe, expect, test } from "bun:test"

import type { ThreadSummary } from "@clavia/tardigrade-client"
import { actorMarkOf, agoOf, countsOf, digestLabelOf, latestRootOf, matches, rosterOf } from "./roster"

// The rail's decisions: which threads are rows, how big each root's family is, what a row's counts
// say, and how an age reads. All pure, so none of them needs a server or a DOM.

const summary = (id: string, parent?: string, events = 1): ThreadSummary => ({
  id,
  ...(parent === undefined ? {} : { parent }),
  events,
  status: "settled"
})

describe("rosterOf", () => {
  const listing = [
    summary("root", undefined, 34),
    summary("t1.0", "root", 19),
    summary("t1.0.1", "t1.0", 9),
    summary("t1.1", "root", 12),
    summary("alone", undefined, 29)
  ]

  test("the rows are the roots, in the order the listing published them", () => {
    expect(rosterOf(listing).roots.map((row) => row.id)).toEqual(["root", "alone"])
  })

  test("the latest root is the last published root", () => {
    expect(latestRootOf(rosterOf(listing))?.id).toBe("alone")
    expect(latestRootOf(rosterOf([]))).toBeUndefined()
  })

  test("a root's family is every thread under it, at any depth", () => {
    const roots = rosterOf(listing).roots
    expect(roots[0]?.family).toBe(3)
    expect(roots[1]?.family).toBe(0)
  })

  test("a root keeps its own event count, which is the only count the rail states", () => {
    expect(rosterOf(listing).roots.map((row) => row.events)).toEqual([34, 29])
  })

  test("an empty listing is an empty rail", () => {
    expect(rosterOf([]).roots).toEqual([])
  })

  test("a parent that claims its own ancestor still resolves to one root", () => {
    const cycle = [summary("a", "b"), summary("b", "a"), summary("c")]
    expect(rosterOf(cycle).roots.map((row) => row.id)).toEqual(["c"])
  })
})

describe("countsOf", () => {
  const row = { id: "root", status: "settled" as const, events: 34, lastAt: undefined }

  test("a root that spawned nothing says nothing about threads", () => {
    expect(countsOf({ ...row, family: 0 })).toBe("34 ev")
  })

  test("a root with a family states its size", () => {
    expect(countsOf({ ...row, family: 9 })).toBe("34 ev · 9 threads")
  })
})

describe("matches", () => {
  test("the search reads ids, case-folded, anywhere in the id", () => {
    expect(matches("PR-shepherd", " shep ")).toBe(true)
    expect(matches("pr-shepherd", "deploy")).toBe(false)
    expect(matches("pr-shepherd", "")).toBe(true)
  })
})

describe("digestLabelOf", () => {
  test("an actor digest reads as short hexadecimal identity", () => {
    expect(digestLabelOf("sha256:beb340c42043b306", 7)).toBe("beb340c")
    expect(digestLabelOf("custom-digest", 6)).toBe("custom")
  })
})

describe("actorMarkOf", () => {
  test("a single name keeps its leading characters", () => {
    expect(actorMarkOf("researcher", 2)).toBe("RE")
  })

  test("a compound name uses its parts", () => {
    expect(actorMarkOf("pr-shepherd", 2)).toBe("PS")
  })
})

describe("agoOf", () => {
  const now = 1_700_000_000_000

  test("seconds under a minute, minutes under an hour, hours beyond", () => {
    expect(agoOf(now, now)).toBe("0s")
    expect(agoOf(now - 59_000, now)).toBe("59s")
    expect(agoOf(now - 60_000, now)).toBe("1m")
    expect(agoOf(now - 3_600_000, now)).toBe("1h")
  })

  test("a timestamp ahead of the reader's clock reads as no age at all", () => {
    expect(agoOf(now + 5_000, now)).toBe("0s")
  })
})
