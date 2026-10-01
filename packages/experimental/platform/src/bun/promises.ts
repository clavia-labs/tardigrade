import { isDeepStrictEqual } from "node:util"
import { Clock, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { ClockHandle, RuntimeError, type ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { Promises, ResolutionSettled as PromiseSettled, ResolutionRequest, resolutionKey, promisePolicy, type ResolutionPoll, type PromisePolicy } from "@clavia/tardigrade-experimental-core"

// bunPromises resolves promises in actor-scoped fibers and retains settlements while delivery is retried.
export function bunPromises(host: Pick<ActorRuntime<object>, "fork" | "interrupt">, options: {
  readonly poll?: ResolutionPoll
  readonly deliver: (settlement: PromiseSettled) => Effect.Effect<void, Error>
  readonly policy?: Partial<PromisePolicy>
  readonly onError?: (error: Error, request: ResolutionRequest) => void
}) {
  return Layer.effect(Promises, Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const timers = new Map<string, Fiber.Fiber<void, Error>>()
    const policy = promisePolicy(options.policy)
    const registered = new Map<string, { request: ResolutionRequest; expiresAt?: number; cancelled: boolean }>()
    const prune = (now: number) => { for (const [key, entry] of registered) if (entry.expiresAt !== undefined && entry.expiresAt <= now) registered.delete(key) }
    return {
      watch: request => Effect.gen(function* () {
        const value = yield* Schema.decodeEffect(ResolutionRequest)(request)
        const clock = value.handle.executor === "clock" ? yield* Schema.decodeUnknownEffect(ClockHandle)(value.handle) : undefined
        if (!clock && !options.poll) return yield* Effect.fail(new RuntimeError("Bun resolver has no polling adapter"))
        if (!clock && (value.mode ?? value.handle.mode) === "push") return yield* Effect.fail(new RuntimeError("Bun resolver requires a polling adapter; push delivery requires an inbox"))
        prune(yield* Clock.currentTimeMillis)
        const key = resolutionKey(value)
        const previous = registered.get(key)
        if (previous) {
          if (!isDeepStrictEqual(previous.request, value)) return yield* Effect.fail(new RuntimeError("Promise reference already registered with another handle"))
          return
        }
        const entry: { request: ResolutionRequest; expiresAt?: number; cancelled: boolean } = { request: value, cancelled: false }
        registered.set(key, entry)
        const run = Effect.gen(function* () {
          let settlement: PromiseSettled | undefined
          if (clock) {
            let remaining = clock.at - (yield* Clock.currentTimeMillis)
            while (remaining > 0) {
              // Native timers accept signed 32-bit delays; longer deadlines require successive sleeps.
              yield* Effect.sleep(Math.min(remaining, 2_147_483_647))
              remaining = clock.at - (yield* Clock.currentTimeMillis)
            }
            settlement = { type: "PromiseSettled", ref: value.ref, result: { status: "fulfilled", value: clock.value === undefined ? { at: clock.at } : clock.value } }
          }
          while (!entry.cancelled) {
            const attempt = yield* Effect.gen(function* () {
              if (!settlement) {
                const result = yield* options.poll!(value.handle).pipe(Effect.timeout(policy.attemptTimeoutMs))
                if (result.status === "pending") return false
                settlement = yield* Schema.decodeEffect(PromiseSettled)({ type: "PromiseSettled", ref: value.ref, result })
              }
              if (entry.cancelled) return true
              yield* options.deliver(settlement).pipe(Effect.timeout(policy.attemptTimeoutMs))
              return true
            }).pipe(Effect.result)
            if (attempt._tag === "Success" && attempt.success) return
            if (attempt._tag === "Failure") {
              const error = RuntimeError.from(attempt.failure)
              if (options.onError) options.onError(error, value)
              else yield* Effect.logError("Promise resolution retry", error.message)
            }
            yield* Effect.sleep(attempt._tag === "Failure" ? policy.retryIntervalMs : policy.pollIntervalMs)
          }
        }).pipe(Effect.ensuring(Effect.gen(function* () { entry.expiresAt = (yield* Clock.currentTimeMillis) + policy.retentionMs })))
        if (clock) {
          const fiber = yield* Effect.forkIn(run.pipe(Effect.ensuring(Effect.sync(() => { timers.delete(key) }))), scope)
          timers.set(key, fiber)
          return
        }
        yield* host.fork(`resolver:${key}`, run).pipe(Effect.tapError(() => Effect.sync(() => { registered.delete(key) })))
      }),
      cancel: request => Effect.gen(function* () {
        const value = yield* Schema.decodeEffect(ResolutionRequest)(request)
        const now = yield* Clock.currentTimeMillis
        prune(now)
        const key = resolutionKey(value)
        const entry = registered.get(key)
        if (entry && !isDeepStrictEqual(entry.request, value)) return yield* Effect.fail(new RuntimeError("Promise reference already registered with another handle"))
        if (!entry) { registered.set(key, { request: value, cancelled: true, expiresAt: now + policy.retentionMs }); return }
        entry.cancelled = true
        const timer = timers.get(key)
        if (timer) yield* Fiber.interrupt(timer)
        else if (entry.expiresAt === undefined) yield* host.interrupt(`resolver:${key}`)
      }),
    } satisfies typeof Promises.Service
  }))
}
