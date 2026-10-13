import { Clock, Deferred, Effect, Schema } from "effect"
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

export interface SlowActOptions { readonly workMs: number; readonly value: number; readonly hold?: boolean; readonly fork?: { readonly timeoutMs: number } }
export interface SlowActLog { readonly kind: "start" | "interrupted" | "done"; readonly at: number }

// slowServices exposes execution barriers and lifecycle observations for watchdog tests.
export function slowServices(options: SlowActOptions) {
  const log: SlowActLog[] = []
  const starts = new Map<number, Deferred.Deferred<void>>()
  const released = Deferred.makeUnsafe<void>()
  let executions = 0
  const started = (index: number) => {
    let barrier = starts.get(index)
    if (!barrier) { barrier = Deferred.makeUnsafe<void>(); starts.set(index, barrier) }
    return barrier
  }
  const note = (kind: SlowActLog["kind"]) => Effect.gen(function* () {
    log.push({ kind, at: yield* Clock.currentTimeMillis })
    if (kind === "start") yield* Deferred.succeed(started(++executions), undefined)
  })
  return { log: () => [...log], started: (index: number) => Deferred.await(started(index)), release: Deferred.succeed(released, undefined).pipe(Effect.asVoid), services: Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    const work = note("start").pipe(Effect.andThen(options.hold ? Deferred.await(released) : Effect.sleep(options.workMs)), Effect.andThen(note("done")), Effect.as(options.value), Effect.onInterrupt(() => note("interrupted")))
    if (!options.fork) return yield* work
    const promise = durablePromise(execution.ref, { success: Schema.Finite, error: Schema.String })
    const handle = yield* execution.fork(work.pipe(Effect.match({ onFailure: error => promise.fail(String(error)), onSuccess: promise.succeed })), options.fork)
    return Job.defer(handle)
  }).pipe(Effect.mapError(String))) }
}
