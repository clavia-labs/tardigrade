import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { costsOf } from "./cost"

const pricing = { promptUsdPerToken: 0.01, completionUsdPerToken: 0.02 }
const called = (callId: string, turn = "t"): Event => ({ type: "ModelCalled", callId, turn, ordinal: 0, pricing, at: 1 })
const returned = (callId: string, extra: Record<string, unknown> = {}): Event => ({
  type: "ModelReturned", callId, turn: "t", ordinal: 0, outcome: "returned", at: 2,
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, ...extra
})

test("costs include failed attempts and retries using each attempt's recorded prices", () => {
  const events = [called("a"), returned("a", { outcome: "failed", reportedCostUsd: 0.1 }),
    { ...called("b"), pricing: { ...pricing, completionUsdPerToken: 0.04 } }, returned("b", { reportedCostUsd: 0.2 })]
  const before = JSON.stringify(events)
  const costs = costsOf(events)
  expect(costs.attempts).toEqual([
    { callId: "a", turn: "t", outcome: "failed", reportedUsd: 0.1, estimatedUsd: 0.2 },
    { callId: "b", turn: "t", outcome: "returned", reportedUsd: 0.2, estimatedUsd: 0.1 + 0.2 }
  ])
  expect(costs.total.reportedUsd).toBeCloseTo(0.3)
  expect(costs.total.estimatedUsd).toBeCloseTo(0.5)
  expect(costsOf(JSON.parse(before))).toEqual(costs)
  expect(JSON.stringify(events)).toBe(before)
})

test("reported zero remains known while missing reports do not suppress estimates", () => {
  const events = [called("a"), returned("a", { reportedCostUsd: 0 })]
  expect(costsOf(events).total).toEqual({ reportedUsd: 0, estimatedUsd: 0.2 })
  events.push(called("b"), returned("b"))
  expect(costsOf(events).total).toEqual({ estimatedUsd: 0.4 })
})

test("reported cost survives absent usage, and unanswered attempts keep totals unknown", () => {
  const events = [called("a"), returned("a", { usage: {}, reportedCostUsd: 0.1 })]
  expect(costsOf(events).total).toEqual({ reportedUsd: 0.1 })
  events.push(called("b"))
  expect(costsOf(events)).toMatchObject({ attempts: [{ reportedUsd: 0.1 }, { callId: "b", outcome: "pending" }], total: {} })
})

test("turn filtering and pairing scope reused call IDs to their turn", () => {
  const events = [called("a"), returned("a", { reportedCostUsd: 0.1 }), called("a", "other"),
    returned("a", { turn: "other", reportedCostUsd: 0.2 })]
  expect(costsOf(events).attempts).toHaveLength(2)
  expect(costsOf(events, { turn: "other" }).total).toEqual({ reportedUsd: 0.2, estimatedUsd: 0.2 })
  expect(costsOf(events, { turn: "missing" })).toEqual({ attempts: [], total: { reportedUsd: 0, estimatedUsd: 0 } })
})

test("a response without its request retains reported cost without inventing a price", () => {
  expect(costsOf([returned("a", { reportedCostUsd: 0.1 })]).total).toEqual({ reportedUsd: 0.1 })
})
