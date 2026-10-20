import { Effect, Schema } from "effect"
import { RetryScheduled, EffectSettled, PromiseSettled, EffectCancelled, CancellationOutcome, ExecutionResult, RuntimeError, effectKey, scheduleWake, cancelWake, type SchedulerTransaction, type Recorded } from "@clavia/tardigrade-core"

const deadlineWakeId = (ref: RetryScheduled["ref"]) => `promise:${effectKey(ref)}`
const retryWakeId = (ref: RetryScheduled["ref"]) => `effect:${effectKey(ref)}`

// recordRetryWakes commits retry and local promise deadline wakes with their journal records.
export const recordRetryWakes = <Event extends object>(tx: SchedulerTransaction, records: readonly Recorded<Event>[]) => Effect.gen(function* () {
  for (const { event } of records) {
    if (Schema.is(RetryScheduled)(event)) {
      yield* scheduleWake(tx, { id: retryWakeId(event.ref), dueAt: event.dueAt, target: { owner: "effect", ref: event.ref } })
    } else if (Schema.is(EffectCancelled)(event) || Schema.is(PromiseSettled)(event) || Schema.is(CancellationOutcome)(event)) {
      yield* cancelWake(tx, retryWakeId(event.ref))
      yield* cancelWake(tx, deadlineWakeId(event.ref))
    } else if (Schema.is(EffectSettled)(event)) {
      const result = event.outcome.status === "fulfilled" ? yield* Schema.decodeUnknownEffect(ExecutionResult)(event.outcome.value).pipe(Effect.mapError(RuntimeError.from)) : undefined
      if (!result || result.type === "value") {
        yield* cancelWake(tx, retryWakeId(event.ref))
        yield* cancelWake(tx, deadlineWakeId(event.ref))
      } else if (result.handle.executor === "local" && result.deadlineAt !== undefined) {
        yield* scheduleWake(tx, { id: deadlineWakeId(event.ref), dueAt: result.deadlineAt, target: { owner: "effect", ref: event.ref } })
      }
    }
  }
})
