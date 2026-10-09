import { strict as assert } from "node:assert"
import { Schema } from "effect"
import { RetryScheduled, EffectSettled, ExecutionResult, type EffectRef, type MethodResult, type Recorded } from "@clavia/tardigrade-core"
import type { RetryServiceOptions } from "../../fixtures/retry-actor"
import { waitFor } from "../../fixtures/wait"

export interface RetryFixture {
  readonly start: () => Promise<void>
  readonly result: () => Promise<MethodResult<number> | undefined>
  readonly records: () => Promise<readonly Recorded<object>[]>
  readonly restart: () => Promise<void>
  readonly cancel: (ref: EffectRef) => Promise<void>
  readonly stats: () => Promise<{ readonly attempts: number; readonly startedAt: readonly number[] }>
  readonly recoveryWake: () => Promise<number | undefined>
  readonly close: () => Promise<void>
}

const retryOf = async (fixture: RetryFixture) => {
  const retry = await waitFor(async () => (await fixture.records()).map(record => record.event).find(Schema.is(RetryScheduled)), value => value !== undefined)
  assert.ok(retry)
  return retry
}
const resultOf = (fixture: RetryFixture) => waitFor(fixture.result, value => value !== undefined)
const afterRetry = (retry: RetryScheduled) => waitFor(async () => Date.now(), now => now > retry.dueAt + 20)

const repeatedRetries = async (fixture: RetryFixture) => {
  await fixture.start()
  assert.deepEqual(await resultOf(fixture), { status: "completed", output: 42 })
  assert.equal((await fixture.stats()).attempts, 3)
  assert.equal((await fixture.records()).filter(record => Schema.is(RetryScheduled)(record.event)).length, 2)
}
const restartRetries = async (fixture: RetryFixture) => {
  await fixture.start()
  const retry = await retryOf(fixture)
  assert.equal((await fixture.stats()).attempts, 1)
  assert.equal(await waitFor(fixture.recoveryWake, at => at === retry.dueAt), retry.dueAt)
  await fixture.restart()
  assert.deepEqual(await resultOf(fixture), { status: "completed", output: 42 })
  const stats = await fixture.stats()
  assert.equal(stats.attempts, 2)
  assert.ok(stats.startedAt[1]! >= retry.dueAt)
  assert.equal((await fixture.records()).filter(record => Schema.is(RetryScheduled)(record.event)).length, 1)
}
const cancelBackoff = async (fixture: RetryFixture) => {
  await fixture.start()
  const retry = await retryOf(fixture)
  await fixture.cancel(retry.ref)
  const result = await resultOf(fixture)
  assert.equal(result?.status, "failed")
  assert.ok(result?.status === "failed" && result.error.includes("Cancelled"))
  await afterRetry(retry)
  assert.equal((await fixture.stats()).attempts, 1)
}
const modes: readonly { readonly name: string; readonly options: RetryServiceOptions }[] = [
  { name: "direct effect", options: {} },
  { name: "promise producer", options: { promiseTimeoutMs: 5_000 } },
]

export const retryScenarios: readonly { readonly name: string; readonly options: RetryServiceOptions; readonly run: (fixture: RetryFixture) => Promise<void> }[] = [
  ...modes.flatMap(mode => [
    { name: `${mode.name} succeeds after two durable retry wakes`, options: mode.options, run: repeatedRetries },
    { name: `${mode.name} restart preserves a retry without executing work early`, options: { ...mode.options, failures: 1, delayMs: 400 }, run: restartRetries },
    { name: `${mode.name} cancellation during backoff prevents another attempt`, options: { ...mode.options, failures: 1, delayMs: 300 }, run: cancelBackoff },
  ]),
  { name: "promise deadline survives restart and precedes the retry wake", options: { failures: 1, delayMs: 1_500, promiseTimeoutMs: 500 }, run: async fixture => {
    await fixture.start()
    const retry = await retryOf(fixture)
    const promiseOf = async () => {
      const settlement = (await fixture.records()).map(record => record.event).find(Schema.is(EffectSettled))
      return settlement?.outcome.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value) : undefined
    }
    const promise = await waitFor(promiseOf, value => value?.type === "promise")
    assert.ok(promise?.type === "promise" && promise.deadlineAt !== undefined)
    const deadline = promise.deadlineAt
    assert.ok(deadline < retry.dueAt)
    assert.equal(await waitFor(fixture.recoveryWake, at => at === deadline), deadline)
    await fixture.restart()
    const result = await resultOf(fixture)
    assert.ok(result?.status === "failed" && result.error.includes("PromiseTimedOut"))
    assert.ok(Date.now() < retry.dueAt)
    const reopened = await promiseOf()
    assert.ok(reopened?.type === "promise" && reopened.deadlineAt === deadline)
    await afterRetry(retry)
    assert.equal((await fixture.stats()).attempts, 1)
  } },
]
