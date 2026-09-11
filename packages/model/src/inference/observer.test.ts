import { expect, test } from "bun:test"
import { Data, Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"
import { deltaDelivery } from "./observer"

class ObserverFailed extends Data.TaggedError("ObserverFailed") {}

const delta = (sequence: number) => ({ actor: "test", instance: "main", thread: "root", turn: "t", logicalAttempt: "l", physicalAttempt: "p", model: { provider: "test", model_id: "m" }, blockIndex: 0, sequence, text: "x" })

test("finishing inference interrupts a blocked observer without waiting for its timeout", async () => {
  let interrupted = false
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const delivery = yield* deltaDelivery({ onDelta: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { interrupted = true }))) }, { bufferCapacity: 1, deliveryTimeoutMs: 10_000 })
    yield* delivery.offer(delta(0))
    yield* Deferred.await(started)
    expect(yield* delivery.offer(delta(1))).toBe(true)
    expect(yield* delivery.offer(delta(2))).toBe(false)
    yield* delivery.finish
    expect(interrupted).toBe(true)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("observer errors do not prevent later delivery", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const seen: number[] = []
    const second = yield* Deferred.make<void>()
    const delivery = yield* deltaDelivery({ onDelta: (item) => {
      seen.push(item.sequence)
      return item.sequence === 0 ? Effect.fail(new ObserverFailed()) : Deferred.succeed(second, undefined).pipe(Effect.asVoid)
    } }, { bufferCapacity: 2, deliveryTimeoutMs: 100 })
    yield* delivery.offer(delta(0))
    yield* delivery.offer(delta(1))
    yield* Deferred.await(second)
    yield* delivery.finish
    expect(seen).toEqual([0, 1])
  }))
})
