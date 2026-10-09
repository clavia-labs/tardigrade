import { Clock, Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, durablePromise, effectAtom, EffectExecution, event } from "@clavia/tardigrade-core"

const RunRequested = event({ type: "RunRequested" })
const requested = durableAtom({ name: "slow.requested", input: RunRequested, schema: Schema.Boolean, initial: false, reduce: () => true })
const Job = act({ name: "slow.job", input: Schema.Null, success: Schema.Finite, failure: Schema.String })

export const slowActor = defineActor("slow", Effect.sync(() => {
  const job = Job.request({ input: null })
  return { schema: RunRequested, atom: effectAtom(get => ({ view: get(job.result), events: {}, acts: get(requested) && get(job.result).status === "pending" ? { job } : {} })), methods: {
    run: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: RunRequested.from(() => ({})), result: (_, get) => {
      const result = get(job.result)
      return result.status === "fulfilled" ? { status: "completed", output: result.value } : result.status === "rejected" ? { status: "failed", error: JSON.stringify(result.reason) } : undefined
    } }),
  } }
}))

export interface SlowActOptions { readonly workMs: number; readonly value: number; readonly fork?: { readonly timeoutMs: number } }
export interface SlowActLog { readonly kind: "start" | "interrupted" | "done"; readonly at: number }

// slowServices exposes execution starts, interruptions, and completions for the liveInline property.
export function slowServices(options: SlowActOptions) {
  const log: SlowActLog[] = []
  const note = (kind: SlowActLog["kind"]) => Clock.currentTimeMillis.pipe(Effect.map(at => { log.push({ kind, at }) }))
  return { log: () => [...log], services: Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    const work = note("start").pipe(Effect.andThen(Effect.sleep(options.workMs)), Effect.andThen(note("done")), Effect.as(options.value), Effect.onInterrupt(() => note("interrupted")))
    if (!options.fork) return yield* work
    const promise = durablePromise(execution.ref, { success: Schema.Finite, error: Schema.String })
    const handle = yield* execution.fork(work.pipe(Effect.match({ onFailure: error => promise.fail(String(error)), onSuccess: promise.succeed })), options.fork)
    return Job.defer(handle)
  }).pipe(Effect.mapError(String))) }
}
