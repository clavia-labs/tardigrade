import { expect, test } from "bun:test"
import type { InferDelta } from "@clavia/tardigrade-client"
import { appendAnswerDelta } from "./streaming-text"

const delta = (sequence: number, kind: "text" | "reasoning", text: string, physicalAttempt = "p1"): InferDelta => ({
  actor: "chat", instance: "main", thread: "root", turn: "m1", logicalAttempt: "a1", physicalAttempt,
  model: { provider: "fixture", model_id: "fixture" }, blockIndex: 0, sequence, kind, text
})

test("interleaved reasoning advances the sequence without entering the answer", () => {
  let state = appendAnswerDelta(undefined, delta(0, "reasoning", "Private thought"))
  expect(state.text).toBe("")
  state = appendAnswerDelta(state, delta(1, "text", "The "))
  state = appendAnswerDelta(state, delta(2, "reasoning", "More thinking"))
  state = appendAnswerDelta(state, delta(3, "text", "answer"))
  expect(state).toMatchObject({ text: "The answer", nextSequence: 4, complete: false })
})

test("missing reasoning deltas suppress partial answers until a new physical attempt", () => {
  const first = appendAnswerDelta(undefined, delta(0, "text", "Stale answer"))
  const gap = appendAnswerDelta(first, delta(2, "reasoning", "Gap"))
  expect(gap).toMatchObject({ text: "", complete: true })
  expect(appendAnswerDelta(gap, delta(3, "text", "Unreliable"))).toEqual(gap)
  const retry = appendAnswerDelta(gap, delta(0, "reasoning", "Retry thinking", "p2"))
  expect(appendAnswerDelta(retry, delta(1, "text", "Fresh answer", "p2"))).toMatchObject({ text: "Fresh answer", complete: false })
  expect(appendAnswerDelta(undefined, delta(4, "text", "Late subscription"))).toMatchObject({ text: "", complete: true })
})
