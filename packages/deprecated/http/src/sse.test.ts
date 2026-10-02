import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { eventTail, inferenceTail, openStreams, streamCursorOf } from "./sse"
import { makeInferenceStream } from "./inference-stream"

test("durable SSE replays pages and releases its idle tail on cancellation", async () => {
  const before = openStreams()
  const reader = Stream.toReadableStream(eventTail(
    (_thread, cursor) => Effect.succeed(cursor === 0 ? [{ seq: 1, event: { type: "Committed" } }] : []),
    () => Effect.never,
    "root", 0, 1, 1000
  )).getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 1\ndata: {"type":"Committed"}')
  expect(openStreams()).toBe(before + 1)
  const pending = reader.read()
  await reader.cancel()
  expect((await pending).done).toBe(true)
  expect(openStreams()).toBe(before)
})

test("inference SSE filters identities, bounds delivery, and unsubscribes on cancellation", async () => {
  const source = makeInferenceStream()
  const reader = Stream.toReadableStream(inferenceTail(source, "main", "root", 1000, 1)).getReader()
  await reader.read()
  expect(source.subscribers()).toBe(1)
  const delta = { actor: "agent", instance: "main", thread: "root", turn: "turn", logicalAttempt: "logical", physicalAttempt: "physical", model: { provider: "test", model_id: "test" }, blockIndex: 0, sequence: 0, text: "hello" }
  await Effect.runPromise(source.observer.onDelta({ ...delta, thread: "other" }))
  await Effect.runPromise(source.observer.onDelta(delta))
  const frame = new TextDecoder().decode((await reader.read()).value)
  expect(frame).toContain('"text":"hello"')
  expect(frame).not.toContain('"thread":"other"')
  for (let sequence = 1; sequence < 100; sequence++) await Effect.runPromise(source.observer.onDelta({ ...delta, sequence }))
  await reader.cancel()
  expect(source.subscribers()).toBe(0)
})

test("SSE cursor validation prefers Last-Event-ID and rejects malformed or unsafe cursors", () => {
  expect(streamCursorOf("1", "2")).toEqual({ from: 2 })
  expect(streamCursorOf(undefined, undefined)).toEqual({})
  for (const invalid of ["", "-1", "1.5", "Infinity", "9007199254740992"]) {
    expect(streamCursorOf(invalid, undefined)).toEqual({ invalid: "after" })
    expect(streamCursorOf("0", invalid)).toEqual({ invalid: "last-event-id" })
  }
})
