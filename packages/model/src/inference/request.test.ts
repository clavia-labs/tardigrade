import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LanguageModel, Response, Toolkit } from "effect/unstable/ai"
import { collectResponse } from "../providers/response"
import { TestClock } from "effect/testing"
import { boundedStream, requestPolicyOf, StreamBoundExceeded } from "./request"

for (const bound of ["firstChunkMs", "idleMs", "attemptMs"] as const) {
  test(`stream interrupts at ${bound}`, async () => {
    let closed = false
    const result = await Effect.runPromise(Effect.gen(function* () {
      const bounds = { firstChunkMs: 100, idleMs: 100, attemptMs: 100, [bound]: 10 }
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
  for (const attemptMs of [undefined, 20]) {
    test(`adapter metadata keeps ${started ? "idle" : "first chunk"} timer alive (attempt limit: ${attemptMs ?? "none"})`, async () => {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const metadata = Stream.range(0, 8).pipe(Stream.mapEffect((id) => Effect.sleep(5).pipe(Effect.as({ type: "response-metadata" as const, id: String(id) }))))
        const prefix = started ? Stream.make(Response.makePart("text-start", { id: "text" }), Response.makePart("text-delta", { id: "text", delta: "hello" })) : Stream.empty
        const ending = Stream.fromIterable([
          ...(started ? [Response.makePart("text-end", { id: "text" })] : []),
          Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) })
        ])
        const layer = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({ generateText: () => Effect.die("stream only"), streamText: () => Stream.concat(Stream.concat(prefix, metadata), ending) }))
        const fiber = yield* collectResponse("Answer", Toolkit.empty, undefined, undefined, { firstChunkMs: 20, idleMs: 20, ...(attemptMs === undefined ? {} : { attemptMs }) }).pipe(Effect.provide(layer), Effect.result, Effect.forkChild)
        yield* TestClock.adjust(60)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())))
      if (attemptMs !== undefined) expect(result).toMatchObject({ _tag: "Failure", failure: { bound: "attemptMs" } })
      else {
        expect(result._tag).toBe("Success")
        if (result._tag === "Success") expect(result.success.parts.filter((part) => part.type === "response-metadata")).toHaveLength(9)
      }
    })
  }
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
