import { expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { boundedStream, requestPolicyOf, StreamBoundExceeded } from "./request"

for (const bound of ["firstContentMs", "idleMs", "attemptMs"] as const) {
  test(`stream interrupts at ${bound}`, async () => {
    let closed = false
    const result = await Effect.runPromise(Effect.gen(function* () {
      const bounds = { firstContentMs: 100, idleMs: 100, attemptMs: 100, [bound]: 10 }
      const source = (bound === "idleMs" ? Stream.concat(Stream.make(1), Stream.never) : Stream.never).pipe(Stream.ensuring(Effect.sync(() => { closed = true })))
      const fiber = yield* boundedStream(source, bounds).pipe(Stream.runCollect, Effect.timeoutOrElse({ duration: bounds.attemptMs, orElse: () => Effect.fail(new StreamBoundExceeded({ bound: "attemptMs" })) }), Effect.result, Effect.forkChild)
      yield* TestClock.adjust(10)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "StreamBoundExceeded", bound } })
    expect(closed).toBe(true)
  })
}

test("request policies reject invalid bounds", () => {
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) expect(() => requestPolicyOf({ timeout: { idleMs: value } })).toThrow()
  for (const value of [-1, Infinity, NaN]) expect(() => requestPolicyOf({ retry: { backoffMs: [value] } })).toThrow()
  expect(requestPolicyOf({ retry: { backoffMs: [] } }).retry.backoffMs).toEqual([])
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
      const fiber = yield* boundedStream(source, { firstContentMs: 20, idleMs: 20 }, (value) => value === "output").pipe(Stream.runCollect, Effect.result, Effect.forkChild)
      yield* TestClock.adjust(20)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(result).toMatchObject({ _tag: "Failure", failure: { bound: started ? "idleMs" : "firstContentMs" } })
  })
}

test("active streams have no default total deadline", async () => {
  const policy = requestPolicyOf({})
  expect(policy.timeout.attemptMs).toBeUndefined()
  const result = await Effect.runPromise(Effect.gen(function* () {
    const source = Stream.range(0, 6).pipe(Stream.mapEffect((n) => Effect.sleep(60_000).pipe(Effect.as(n))))
    const fiber = yield* boundedStream(source, policy.timeout).pipe(Stream.runCollect, Effect.forkChild)
    yield* TestClock.adjust(420_000)
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(TestClock.layer())))
  expect(result).toEqual([0, 1, 2, 3, 4, 5, 6])
})
