import { Clock, Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, EffectExecution, RuntimeError, durablePromise } from "@clavia/tardigrade-core"

const RunRequested = event({ type: "RunRequested" })
const requested = durableAtom({ name: "retry.requested", input: RunRequested, schema: Schema.Boolean, initial: false, reduce: () => true })
const Job = act({ name: "retry.direct", input: Schema.Null, success: Schema.Finite, failure: Schema.String })

export const retryActor = defineActor("direct-retry", Effect.sync(() => {
  const job = Job.request({ input: null })
  return { schema: RunRequested, atom: effectAtom(get => ({ view: get(job.result), events: {}, acts: get(requested) && get(job.result).status === "pending" ? { job } : {} })), methods: {
    run: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: RunRequested.from(() => ({})), result: (_, get) => {
      const result = get(job.result)
      return result.status === "fulfilled" ? { status: "completed", output: result.value } : result.status === "rejected" ? { status: "failed", error: JSON.stringify(result.reason) } : undefined
    } }),
  } }
}))

export interface RetryServiceOptions { readonly failures?: number; readonly delayMs?: number; readonly promiseTimeoutMs?: number }

export function retryServices(options: RetryServiceOptions = {}) {
  let attempts = 0
  const startedAt: number[] = []
  let cancelEffect: typeof EffectExecution.Service.cancel | undefined
  return {
    attempts: () => attempts,
    startedAt: () => [...startedAt],
    cancel: (ref: Parameters<typeof EffectExecution.Service.cancel>[0]) => Effect.suspend(() => cancelEffect ? cancelEffect(ref, "stop") : Effect.fail(new RuntimeError("Effect has not started"))),
    services: Job.layer(() => Effect.gen(function* () {
      const execution = yield* EffectExecution
      cancelEffect = execution.cancel
      const work = Effect.gen(function* () {
        attempts++
        startedAt.push(yield* Clock.currentTimeMillis)
        if (attempts <= (options.failures ?? 2)) return yield* Effect.fail(new RuntimeError("transient"))
        return 42
      })
      const retry = execution.retry(work, { decide: (error, attempt) => Effect.succeed(attempt < (options.failures ?? 2) ? { delayMs: options.delayMs ?? 5, reason: error.message } : undefined) })
      if (options.promiseTimeoutMs === undefined) return yield* retry
      const promise = durablePromise(execution.ref, { success: Schema.Finite, error: Schema.String })
      const handle = yield* execution.fork(retry.pipe(Effect.match({ onFailure: error => promise.fail(String(error)), onSuccess: promise.succeed })), { timeoutMs: options.promiseTimeoutMs })
      return Job.defer(handle)
    }).pipe(Effect.mapError(String))),
  }
}
