import { expect, test } from "bun:test"
import { Duration, Effect, Fiber, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError } from "effect/unstable/ai"
import { boundedStream, requestPolicyOf, retryRequest, StreamBoundExceeded, StreamTruncated } from "./request"

for (const bound of ["firstChunkMs", "idleMs", "totalMs"] as const) {
  test(`stream interrupts at ${bound}`, async () => {
    let closed = false
    const result = await Effect.runPromise(Effect.gen(function* () {
      const bounds = { firstChunkMs: 100, idleMs: 100, totalMs: 100, [bound]: 10 }
      const source = (bound === "idleMs" ? Stream.concat(Stream.make(1), Stream.never) : Stream.never).pipe(Stream.ensuring(Effect.sync(() => { closed = true })))
      const fiber = yield* boundedStream(source, bounds).pipe(Stream.runCollect, Effect.timeoutOrElse({ duration: bounds.totalMs, orElse: () => Effect.fail(new StreamBoundExceeded({ bound: "totalMs" })) }), Effect.result, Effect.forkChild)
      yield* TestClock.adjust(10)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "StreamBoundExceeded", bound } })
    expect(closed).toBe(true)
  })
}

for (const succeeds of [false, true]) {
  test(`transient retries are bounded (success: ${succeeds})`, async () => {
    let attempts = 0
    const error = AiError.make({ module: "test", method: "streamText", reason: AiError.RateLimitError.make({}) })
    const policy = requestPolicyOf({ throttleRetryDelaysMs: [0, 0] })
    const result = await Effect.runPromise(retryRequest(() => Effect.suspend(() => ++attempts === 3 && succeeds ? Effect.succeed("done") : Effect.fail(error)), policy).pipe(Effect.result))
    expect(attempts).toBe(3)
    if (succeeds) expect(result).toEqual(Result.succeed("done"))
    else expect(result).toMatchObject({ _tag: "Failure", failure: { attempts: 3, policy } })
  })
}

test("Retry-After controls the wait and respects its ceiling", async () => {
  for (const delay of [20, 200]) {
    let attempts = 0
    await Effect.runPromise(Effect.gen(function* () {
      const error = AiError.make({ module: "test", method: "streamText", reason: AiError.RateLimitError.make({ retryAfter: Duration.millis(delay) }) })
      const fiber = yield* retryRequest(() => Effect.suspend(() => ++attempts === 1 ? Effect.fail(error) : Effect.succeed("done")), requestPolicyOf({ throttleRetryDelaysMs: [100], retryAfterJitterMs: 0 })).pipe(Effect.result, Effect.forkChild)
      yield* TestClock.adjust(19)
      expect(attempts).toBe(1)
      yield* TestClock.adjust(1)
      const result = yield* Fiber.join(fiber)
      expect(Result.isSuccess(result)).toBe(delay === 20)
      expect(attempts).toBe(delay === 20 ? 2 : 1)
    }).pipe(Effect.provide(TestClock.layer())))
  }
})

test("ordinary failures and interruption do not retry", async () => {
  let attempts = 0
  await Effect.runPromise(retryRequest(() => Effect.suspend(() => { attempts++; return Effect.fail("bad input") }), requestPolicyOf({ throttleRetryDelaysMs: [0] })).pipe(Effect.result))
  expect(attempts).toBe(1)
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* retryRequest(() => Effect.suspend(() => { attempts++; return Effect.never }), requestPolicyOf({})).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
  }))
  expect(attempts).toBe(2)
})

test("request policies reject invalid bounds", () => {
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) expect(() => requestPolicyOf({ stream: { idleMs: value } })).toThrow()
  for (const value of [-1, Infinity, NaN]) expect(() => requestPolicyOf({ throttleRetryDelaysMs: [value] })).toThrow()
  expect(requestPolicyOf({ throttleRetryDelaysMs: [] }).throttleRetryDelaysMs).toEqual([])
})

test("output exhaustion does not retry or increase the limit", async () => {
  const limits: number[] = []
  const result = await Effect.runPromise(retryRequest((maxOutputTokens) => Effect.suspend(() => {
    limits.push(maxOutputTokens)
    return Effect.fail(new StreamTruncated({ maxOutputTokens }))
  }), requestPolicyOf({ maxOutputTokens: 100, throttleRetryDelaysMs: [0, 0] })).pipe(Effect.result))
  expect(limits).toEqual([100])
  expect(result).toMatchObject({ _tag: "Failure", failure: { attempts: 1 } })
})

test("output limits reject invalid values and accept an override", () => {
  for (const maxOutputTokens of [0, -1, 1.5, Infinity]) expect(() => requestPolicyOf({ maxOutputTokens })).toThrow()
  expect(requestPolicyOf({ maxOutputTokens: 50 }).maxOutputTokens).toBe(50)
  expect(requestPolicyOf({}).maxOutputTokens).toBe(32_768)
})

for (const started of [false, true]) {
  test(`metadata cannot extend ${started ? "idle" : "first output"} timeout`, async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const metadata = Stream.range(0, 8).pipe(Stream.mapEffect(() => Effect.sleep(5).pipe(Effect.as("metadata"))))
      const source = started ? Stream.concat(Stream.make("output"), metadata) : metadata
      const fiber = yield* boundedStream(source, { firstChunkMs: 20, idleMs: 20 }, (value) => value === "output").pipe(Stream.runCollect, Effect.result, Effect.forkChild)
      yield* TestClock.adjust(20)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(result).toMatchObject({ _tag: "Failure", failure: { bound: started ? "idleMs" : "firstChunkMs" } })
  })
}

test("active streams have no default total deadline", async () => {
  const policy = requestPolicyOf({})
  expect(policy.stream.totalMs).toBeUndefined()
  const result = await Effect.runPromise(Effect.gen(function* () {
    const source = Stream.range(0, 6).pipe(Stream.mapEffect((n) => Effect.sleep(60_000).pipe(Effect.as(n))))
    const fiber = yield* boundedStream(source, policy.stream).pipe(Stream.runCollect, Effect.forkChild)
    yield* TestClock.adjust(420_000)
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(TestClock.layer())))
  expect(result).toEqual([0, 1, 2, 3, 4, 5, 6])
})
