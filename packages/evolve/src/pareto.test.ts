import { describe, expect, test } from "bun:test"
import { candidate } from "./candidate"
import { paretoArchive } from "./pareto"

const base = candidate("base", { source: "base.ts" })
const specialist = candidate("specialist", { source: "specialist.ts" })
const generalist = candidate("generalist", { source: "generalist.ts" })

const seeded = (from: number) => {
  let state = from
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

describe("the front", () => {
  test("keeps candidates that each lead on one task", () => {
    const archive = paretoArchive<typeof base>()
      .add(base, { "invoice-lookup": 0.71, "refund-policy": 0.55 })
      .add(specialist, { "invoice-lookup": 0.64, "refund-policy": 0.8 })
    expect(archive.front.map((value) => value.id)).toEqual([base.id, specialist.id])
  })

  test("drops a candidate another one beats everywhere", () => {
    const archive = paretoArchive<typeof base>()
      .add(base, { "invoice-lookup": 0.71, "refund-policy": 0.55 })
      .add(specialist, { "invoice-lookup": 0.71, "refund-policy": 0.8 })
    expect(archive.front.map((value) => value.id)).toEqual([specialist.id])
  })

  test("keeps ties and tradeoffs", () => {
    const tied = paretoArchive<typeof base>().add(base, { a: 0.71 }).add(specialist, { a: 0.71 })
    const traded = paretoArchive<typeof base>()
      .add(base, { a: 1, b: 0 })
      .add(specialist, { a: 0, b: 1 })
      .add(generalist, { a: 0.5, b: 0.5 })
    expect(tied.front).toHaveLength(2)
    expect(traded.front).toHaveLength(3)
  })

  test("does not treat a missing score as a win", () => {
    const archive = paretoArchive<typeof base>()
      .add(base, { a: 0.4, b: 0.4 })
      .add(specialist, { a: 0.9 })
    expect(archive.front.map((value) => value.id)).toEqual([base.id, specialist.id])
  })

  test("re-scoring replaces a candidate without mutating the old archive", () => {
    const first = paretoArchive<typeof base>().add(base, { a: 0.4 })
    const second = first.add(specialist, { a: 0.9 }).add(base, { a: 0.95 })
    expect(first.front.map((value) => value.id)).toEqual([base.id])
    expect(second.front.map((value) => value.id)).toEqual([base.id])
  })

  test("starts empty", () => {
    expect(paretoArchive<typeof base>().front).toEqual([])
    expect(paretoArchive<typeof base>().sample(Math.random)).toBeUndefined()
  })
})

describe("sampling", () => {
  const archive = paretoArchive<typeof base>()
    .add(base, { a: 1, b: 0 })
    .add(specialist, { a: 0, b: 1 })
    .add(generalist, { a: 0.5, b: 0.5 })

  test("is a pure function of the random source", () => {
    const rng = seeded(7)
    const drawn = [archive.sample(rng), archive.sample(rng), archive.sample(rng), archive.sample(rng)]
    const again = seeded(7)
    expect(drawn.map((value) => value?.id)).toEqual(
      [archive.sample(again), archive.sample(again), archive.sample(again), archive.sample(again)].map(
        (value) => value?.id
      )
    )
    expect(drawn.every((value) => archive.front.includes(value!))).toBe(true)
  })

  test("covers the whole front and clamps one to the last entry", () => {
    const rng = seeded(3)
    const seen = new Set(Array.from({ length: 60 }, () => archive.sample(rng)?.id))
    expect(seen.size).toBe(3)
    expect(archive.sample(() => 1)?.id).toBe(generalist.id)
    expect(archive.sample(() => 0)?.id).toBe(base.id)
  })
})
