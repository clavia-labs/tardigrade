import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { InferDelta } from "tardie"

import { makeInferenceStream } from "./inference-stream"

const delta: InferDelta = {
  actor: "agent",
  instance: "main",
  thread: "ag.root",
  turn: "turn-1",
  logicalAttempt: "turn-1/infer/0",
  physicalAttempt: "physical-1",
  model: { provider: "openai", model_id: "gpt-mini" },
  blockIndex: 0,
  sequence: 0,
  text: "hello"
}

test("the inference stream fans out and releases subscribers", async () => {
  const received: InferDelta[] = []
  const inference = makeInferenceStream()
  const unsubscribe = inference.subscribe((next) => received.push(next))
  expect(inference.subscribers()).toBe(1)
  await Effect.runPromise(inference.observer.onDelta(delta))
  expect(received).toEqual([delta])
  unsubscribe()
  expect(inference.subscribers()).toBe(0)
})

test("the inference stream preserves an existing observer", async () => {
  const received: InferDelta[] = []
  const inference = makeInferenceStream({
    policy: { bufferCapacity: 3 },
    onDelta: (next) => Effect.sync(() => { received.push(next) })
  })
  expect(inference.observer.policy).toEqual({ bufferCapacity: 3 })
  await Effect.runPromise(inference.observer.onDelta(delta))
  expect(received).toEqual([delta])
})
