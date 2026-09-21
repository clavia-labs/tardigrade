import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CommitSignal, streamPolicyOf } from "./stream"

test("commit notifications retain the latest head across late and cancelled waiters", async () => {
  const signal = new CommitSignal()
  signal.notify(3)
  signal.notify(1)
  expect(await Effect.runPromise(signal.awaitHead(0))).toBe(3)
  const abort = new AbortController()
  const cancelled = Effect.runPromise(signal.awaitHead(3), { signal: abort.signal })
  abort.abort()
  await expect(cancelled).rejects.toBeDefined()
  const next = Effect.runPromise(signal.awaitHead(3))
  signal.notify(4)
  expect(await next).toBe(4)
})

test("stream policies accept overrides and reject unbounded or empty settings", () => {
  expect(streamPolicyOf({ pageSize: 1 }).pageSize).toBe(1)
  for (const name of ["pageSize", "heartbeatMillis", "inferenceBufferCapacity"] as const) {
    for (const value of [0, -1, Infinity, 1.5]) expect(() => streamPolicyOf({ [name]: value })).toThrow()
  }
})
