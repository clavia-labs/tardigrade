import { expect, test } from "bun:test"
import { Clock, Context, Effect, Layer, Scope } from "effect"
import { DEFAULT_PROMISE_POLICY, Promises, promiseDeadline, promisePolicy, type ResolutionSettled } from "@clavia/tardigrade-core"
import { bunPromises } from "../../src/bun/promises"

test("promise policy validates host settings and respects scheduled clocks", () => {
  expect(DEFAULT_PROMISE_POLICY.pollIntervalMs).toBe(1_000)
  expect(DEFAULT_PROMISE_POLICY.timeoutMs).toBe(60_000)
  expect(() => promisePolicy({ timeoutMs: 0 })).toThrow()
  expect(() => promisePolicy({ pollIntervalMs: 1.5 })).toThrow()
  expect(promiseDeadline({ executor: "clock", id: "later", at: 100_000 }, 10, promisePolicy())).toBe(160_000)
  expect(promiseDeadline({ executor: "remote", id: "job" }, 10, promisePolicy(), 123)).toBe(123)
})

test("Bun inherits host polling policy and expires pending results", async () => {
  const times: number[] = []
  const delivered: ResolutionSettled[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const resolver = bunPromises({
      promisePolicy: promisePolicy({ timeoutMs: 60, pollIntervalMs: 5 }),
      fork: (_id, work) => Effect.forkIn(work, scope).pipe(Effect.asVoid),
      interrupt: () => Effect.void,
    }, {
      poll: () => Clock.currentTimeMillis.pipe(Effect.tap(now => Effect.sync(() => { times.push(now) })), Effect.as({ status: "pending" as const })),
      deliver: result => Effect.sync(() => { delivered.push(result) }),
    })
    const services = yield* Layer.build(resolver)
    const promises = Context.get(services, Promises)
    const request = { ref: { atom: "a", seq: 1, act: "job" }, handle: { executor: "remote", id: "job" } }
    yield* promises.watch(request)
    yield* promises.watch(request)
    while (!delivered.length) yield* Effect.sleep(2)
    yield* promises.watch(request)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.result.status).toBe("rejected")
    const result = delivered[0]!.result
    expect(result.status === "rejected" && typeof result.reason !== "string" && result.reason._tag).toBe("PromiseTimedOut")
    expect(times.length).toBeGreaterThan(2)
    expect(times.slice(1).every((time, i) => time - times[i]! >= 4)).toBe(true)
  }).pipe(Effect.scoped, Effect.timeout(2_000)))
})

test("Bun honors cancellation before optional-deadline registration", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    let forks = 0
    let deliveries = 0
    const services = yield* Layer.build(bunPromises({
      fork: () => Effect.sync(() => { forks++ }),
      interrupt: () => Effect.void,
    }, {
      poll: () => Effect.succeed({ status: "fulfilled" as const, value: "late" }),
      deliver: () => Effect.sync(() => { deliveries++ }),
    }))
    const promises = Context.get(services, Promises)
    const request = { ref: { atom: "a", seq: 1, act: "job" }, handle: { executor: "remote", id: "job" } }
    yield* promises.cancel(request)
    yield* promises.watch(request)
    yield* promises.cancel(request)
    expect(forks).toBe(0)
    expect(deliveries).toBe(0)
    yield* promises.watch({ ...request, handle: { ...request.handle, id: "other" } }).pipe(
      Effect.result,
      Effect.tap(result => Effect.sync(() => { expect(result._tag).toBe("Failure") })),
    )
  }).pipe(Effect.scoped))
})
