import { describe, expect, test } from "bun:test"

import type { ActorThread } from "@clavia/tardigrade-client"
import { latestRootOf, listOf, matches } from "./list"

// The rail's decisions: which threads are rows, how big each root's family is, what a row's counts
// say, and how an age reads. All pure, so none of them needs a server or a DOM.

const thread = (id: string, parent?: string): ActorThread => ({
  id,
  ...(parent === undefined ? {} : { parent }),
  depth: parent === undefined ? 0 : 1
})

describe("listOf", () => {
  const listing = [
    thread("root"),
    thread("t1.0", "root"),
    thread("t1.0.1", "t1.0"),
    thread("t1.1", "root"),
    thread("alone")
  ]

  test("the rows are the roots, in the order the listing published them", () => {
    expect(listOf(listing).roots.map((row) => row.id)).toEqual(["root", "alone"])
  })

  test("the latest root is the last published root", () => {
    expect(latestRootOf(listOf(listing))?.id).toBe("alone")
    expect(latestRootOf(listOf([]))).toBeUndefined()
  })

  test("a root's family is every thread under it, at any depth", () => {
    const roots = listOf(listing).roots
    expect(roots[0]?.family).toBe(3)
    expect(roots[1]?.family).toBe(0)
  })

  test("an empty listing is an empty rail", () => {
    expect(listOf([]).roots).toEqual([])
  })

  test("a parent that claims its own ancestor still resolves to one root", () => {
    const cycle = [thread("a", "b"), thread("b", "a"), thread("c")]
    expect(listOf(cycle).roots.map((row) => row.id)).toEqual(["c"])
  })
})

describe("matches", () => {
  test("the search reads ids, case-folded, anywhere in the id", () => {
    expect(matches("PR-shepherd", " shep ")).toBe(true)
    expect(matches("pr-shepherd", "deploy")).toBe(false)
    expect(matches("pr-shepherd", "")).toBe(true)
  })
})
