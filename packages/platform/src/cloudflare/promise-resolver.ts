import { makeRetryingRpc, type CloudflareRetryOptions } from "@clavia/tardigrade-cloudflare/retry"
import { makeAlarmScheduling, type DurableObjectAlarmsOptions } from "@clavia/tardigrade-cloudflare/layers/alarms"
import { type DurableObjectRpcOptions } from "@clavia/tardigrade-cloudflare/layers/rpc"
import type { ThreadCoordinate } from "@clavia/tardigrade-core"
import type { DurableObjectStorage, DurableObjectTransaction } from "@cloudflare/workers-types"
import { isDeepStrictEqual } from "node:util"
import { Clock, Effect, Layer, Schema, Semaphore } from "effect"
import { ClockHandle, ExecutionHandle, RuntimeError } from "@clavia/tardigrade-core"
import { Promises, ResolutionSettled as PromiseSettled, ResolutionResult, ResolutionRegistration, registrationKey, promiseDeadline, promisePolicy, type ResolutionPoll, type PromisePolicy } from "@clavia/tardigrade-core"

export interface PromiseResolverStub {
  readonly watch: (request: ResolutionRegistration) => Promise<void>
  readonly cancel: (request: ResolutionRegistration) => Promise<void>
}

// cloudflarePromises binds an actor's promise service to a promise resolver DO; registration acknowledges durable acceptance by that DO.
export function cloudflarePromises(options: {
  readonly recipient: ThreadCoordinate
  readonly namespace: { readonly getByName: (name: string) => PromiseResolverStub }
  readonly name: string
  readonly rpc?: DurableObjectRpcOptions & CloudflareRetryOptions
  readonly policy?: Partial<PromisePolicy>
}) {
  const policy = promisePolicy(options.policy)
  const rpc = makeRetryingRpc(options.rpc)
  const invoke = (method: "watch" | "cancel", request: Parameters<typeof Promises.Service.watch>[0]) =>
    rpc.call(options.namespace, options.name, method, stub => stub[method]({ ...request, recipient: options.recipient }), true)
      .pipe(Effect.timeout(policy.attemptTimeoutMs))
  return Layer.succeed(Promises, { watch: request => invoke("watch", request), cancel: request => invoke("cancel", request) })
}

export const PromiseResolverCompletion = Schema.Struct({ handle: ExecutionHandle, result: ResolutionResult })
export type PromiseResolverCompletion = typeof PromiseResolverCompletion.Type
export const PromiseResolverNotification = Schema.Struct({ id: Schema.NonEmptyString, handle: ExecutionHandle, result: Schema.optionalKey(ResolutionResult) })
export type PromiseResolverNotification = typeof PromiseResolverNotification.Type
const Entry = Schema.Struct({
  request: ResolutionRegistration, nextAt: Schema.NullOr(Schema.Finite), done: Schema.Boolean,
  settlement: Schema.optionalKey(PromiseSettled), polling: Schema.optionalKey(Schema.Boolean), error: Schema.optionalKey(Schema.String),
})
type Entry = typeof Entry.Type
const Incoming = Schema.Struct({ handle: ExecutionHandle, result: Schema.optionalKey(ResolutionResult), resultReceivedAt: Schema.optionalKey(Schema.Finite), notified: Schema.optionalKey(Schema.Boolean), expiresAt: Schema.Finite })
type Incoming = typeof Incoming.Type
const prefix = "inbox:job:"
const incomingPrefix = "inbox:result:"
const receiptPrefix = "inbox:webhook:"
const handleKey = (handle: ExecutionHandle) => JSON.stringify([handle.executor, handle.id, handle.endpoint ?? null, handle.at ?? null, handle.value === undefined ? [] : [handle.value]])

// createCloudflarePromiseResolver owns a dedicated DO's storage; acknowledged payloads are discarded and deduplication receipts expire by policy.
export function createCloudflarePromiseResolver(options: {
  readonly storage: DurableObjectStorage
  readonly alarms?: DurableObjectAlarmsOptions
  readonly poll?: ResolutionPoll
  readonly deliver: (recipient: ThreadCoordinate, settlement: PromiseSettled) => Effect.Effect<void, Error>
  readonly verifyWebhook?: (request: Request) => Effect.Effect<PromiseResolverNotification, Error>
  readonly policy?: Partial<PromisePolicy>
}) {
  const policy = promisePolicy(options.policy)
  const storage = options.storage
  const decode = Schema.decodeUnknownEffect(Entry)
  const io = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ try: run, catch: RuntimeError.from })
  const lock = Semaphore.makeUnsafe(1)
  // transaction retains the caller context across Cloudflare's Promise callback and holds the permit until storage settles.
  const transaction = <Value>(work: (tx: DurableObjectTransaction) => Effect.Effect<Value, Error>) => lock.withPermit(Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    return yield* io(() => storage.transaction(tx => Effect.runPromiseWith(context)(work(tx))))
  }).pipe(Effect.uninterruptible))
  const schedule = (tx: Pick<DurableObjectStorage, "list" | "setAlarm" | "deleteAlarm">) => Effect.gen(function* () {
    const jobs = yield* io(() => tx.list<Entry>({ prefix }))
    const results = yield* io(() => tx.list<Incoming>({ prefix: incomingPrefix }))
    const receipts = yield* io(() => tx.list<number>({ prefix: receiptPrefix }))
    const entries = yield* Effect.forEach(jobs.values(), value => decode(value))
    const incoming = yield* Effect.forEach(results.values(), value => Schema.decodeEffect(Incoming)(value))
    const times = entries.map(value => value.nextAt).filter((time): time is number => time !== null)
    times.push(...receipts.values(), ...incoming.map(value => value.expiresAt))
    const alarms = makeAlarmScheduling(tx, options.alarms)
    yield* times.length ? alarms.set(times.reduce((first, time) => Math.min(first, time))) : alarms.delete
  }).pipe(Effect.mapError(RuntimeError.from))
  const update = (key: string, change: (entry: Entry, now: number) => Entry) => transaction(tx => Effect.gen(function* () {
    const value = yield* io(() => tx.get<Entry>(key))
    if (value) {
      const entry = yield* decode(value)
      if (!entry.done) {
        const now = yield* Clock.currentTimeMillis
        yield* io(() => tx.put(key, change(entry, now)))
      }
    }
    yield* schedule(tx)
  }).pipe(Effect.mapError(RuntimeError.from)))
  const register = (input: ResolutionRegistration, cancelled: boolean) => transaction(tx => Effect.gen(function* () {
    let request = yield* Schema.decodeEffect(ResolutionRegistration)(input)
    const now = yield* Clock.currentTimeMillis
    const key = prefix + registrationKey(request)
    const raw = yield* io(() => tx.get<Entry>(key))
    const previous = raw ? yield* decode(raw) : undefined
    request = { ...request, deadlineAt: promiseDeadline(request.handle, now, policy, request.deadlineAt ?? previous?.request.deadlineAt) }
    if (previous && !isDeepStrictEqual(previous.request, request)) return yield* Effect.fail(new RuntimeError("Promise reference already registered with another handle"))
    if (cancelled) yield* io(() => tx.put(key, { request, done: true, nextAt: now + policy.retentionMs } satisfies Entry))
    else if (!previous) {
      const clock = request.handle.executor === "clock" ? yield* Schema.decodeUnknownEffect(ClockHandle)(request.handle) : undefined
      if (!clock && (request.mode ?? request.handle.mode) !== "push" && !options.poll) return yield* Effect.fail(new RuntimeError("Promise resolver has no polling adapter; use push mode"))
      const incoming = yield* io(() => tx.get<Incoming>(incomingPrefix + handleKey(request.handle)))
      const active = incoming && incoming.expiresAt > now ? incoming : undefined
      // resultReceivedAt preserves the first completion's arrival; legacy buffers retain their accepted result (test/workerd/promise-resolver.workers.ts).
      const result = active?.result && (active.resultReceivedAt === undefined || active.resultReceivedAt < request.deadlineAt!) ? active.result : undefined
      yield* io(() => tx.put(key, {
        request, done: false, ...(active?.notified ? { polling: true } : {}), nextAt: result || active?.notified ? now : clock ? Math.min(request.deadlineAt!, Math.max(now, clock.at)) : (request.mode ?? request.handle.mode) !== "push" ? now : request.deadlineAt!,
        ...(result ? { settlement: { type: "PromiseSettled", ref: request.ref, result } as PromiseSettled } : {}),
      } satisfies Entry))
    }
    yield* schedule(tx)
  }).pipe(Effect.mapError(RuntimeError.from)))
  // accept receives trusted completions from RPC or an authenticated webhook adapter and retains early arrivals.
  const accept = (input: PromiseResolverCompletion | PromiseResolverNotification) => transaction(tx => Effect.gen(function* () {
    const completion = "id" in input ? yield* Schema.decodeEffect(PromiseResolverNotification)(input) : yield* Schema.decodeEffect(PromiseResolverCompletion)(input)
    const now = yield* Clock.currentTimeMillis
    const receipt = "id" in completion ? receiptPrefix + completion.id : undefined
    if (receipt && ((yield* io(() => tx.get<number>(receipt))) ?? 0) > now) return
    if (!completion.result && !options.poll) return yield* Effect.fail(new RuntimeError("Promise resolver notification requires a polling adapter"))
    const id = handleKey(completion.handle)
    const key = incomingPrefix + id
    const previous = yield* io(() => tx.get<Incoming>(key))
    if (previous && previous.expiresAt > now && previous.result && completion.result && !isDeepStrictEqual(previous.result, completion.result)) return yield* Effect.fail(new RuntimeError("Conflicting promise completion"))
    const entries = yield* io(() => tx.list<Entry>({ prefix }))
    const matching = [...entries].filter(([, value]) => handleKey(value.request.handle) === id)
    let needed = matching.length === 0
    for (const [jobKey, value] of matching) {
      const entry = yield* decode(value)
      if (entry.done) continue
      if (entry.settlement?.result.status === "rejected" && typeof entry.settlement.result.reason !== "string" && entry.settlement.result.reason._tag === "PromiseTimedOut") continue
      if (!entry.settlement && entry.request.deadlineAt !== undefined && entry.request.deadlineAt <= now) {
        yield* io(() => tx.put(jobKey, { ...entry, nextAt: now, settlement: { type: "PromiseSettled", ref: entry.request.ref, result: { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt: entry.request.deadlineAt! } } } } satisfies Entry))
        continue
      }
      needed = true
      if (entry.settlement && completion.result && !isDeepStrictEqual(entry.settlement.result, completion.result)) return yield* Effect.fail(new RuntimeError("Conflicting promise completion"))
      yield* io(() => tx.put(jobKey, { ...entry, nextAt: now, ...(!completion.result ? { polling: true } : {}), ...(completion.result ? { settlement: { type: "PromiseSettled", ref: entry.request.ref, result: completion.result } as PromiseSettled } : {}) } satisfies Entry))
    }
    const active = previous && previous.expiresAt > now ? previous : undefined
    const result = completion.result ?? active?.result
    const resultReceivedAt = active?.result ? active.resultReceivedAt : completion.result ? now : undefined
    yield* io(() => tx.put(key, { handle: completion.handle, ...(needed ? { ...(result ? { result, ...(resultReceivedAt !== undefined ? { resultReceivedAt } : {}) } : {}), notified: true } : {}), expiresAt: active?.expiresAt ?? now + policy.retentionMs } satisfies Incoming))
    if (receipt) yield* io(() => tx.put(receipt, now + policy.retentionMs))
    yield* schedule(tx)
  }).pipe(Effect.mapError(RuntimeError.from)))
  const discard = transaction(tx => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const jobs = yield* io(() => tx.list<Entry>({ prefix }))
    const receipts = yield* io(() => tx.list<number>({ prefix: receiptPrefix }))
    for (const [key, expiresAt] of receipts) if (expiresAt <= now) yield* io(() => tx.delete(key))
    for (const [key, raw] of jobs) {
      const entry = yield* decode(raw)
      if (entry.done && entry.nextAt !== null && entry.nextAt <= now) { yield* io(() => tx.delete(key)); jobs.delete(key) }
    }
    const incomingEntries = yield* io(() => tx.list<Incoming>({ prefix: incomingPrefix }))
    for (const [key, raw] of incomingEntries) {
      const incoming = yield* Schema.decodeEffect(Incoming)(raw)
      if (incoming.expiresAt <= now) yield* io(() => tx.delete(key))
      else if (incoming.result && ![...jobs.values()].some(entry => !entry.done && handleKey(entry.request.handle) === handleKey(incoming.handle)) && [...jobs.values()].some(entry => handleKey(entry.request.handle) === handleKey(incoming.handle))) {
        yield* io(() => tx.put(key, { handle: incoming.handle, expiresAt: incoming.expiresAt } satisfies Incoming))
      }
    }
    yield* schedule(tx)
  }).pipe(Effect.mapError(RuntimeError.from)))
  return {
    watch: (request: ResolutionRegistration) => register(request, false),
    cancel: (request: ResolutionRegistration) => register(request, true).pipe(Effect.andThen(discard)),
    accept,
    webhook: (request: Request) => Effect.gen(function* () {
      if (!options.verifyWebhook) return new Response("Webhook adapter not configured", { status: 404 })
      const verified = yield* options.verifyWebhook(request).pipe(Effect.timeout(policy.attemptTimeoutMs), Effect.result)
      if (verified._tag === "Failure") return new Response("Invalid webhook", { status: 401 })
      return yield* accept(verified.success).pipe(
        Effect.as(new Response(null, { status: 204 })),
        Effect.orElseSucceed(() => new Response("Completion not accepted", { status: 503 })),
      )
    }),
    alarm: Effect.gen(function* () {
      yield* discard
      const jobs = yield* io(() => storage.list<Entry>({ prefix }))
      for (const [key, raw] of jobs) {
        const entry = yield* decode(raw)
        const now = yield* Clock.currentTimeMillis
        if (entry.done || entry.nextAt === null || entry.nextAt > now) continue
        const deadlineAt = promiseDeadline(entry.request.handle, now, policy, entry.request.deadlineAt)
        yield* update(key, (current, now) => ({ ...current, request: { ...current.request, deadlineAt }, nextAt: current.settlement ? now + policy.retryIntervalMs : Math.min(deadlineAt, now + policy.retryIntervalMs) }))
        yield* Effect.gen(function* () {
          if (!entry.settlement && deadlineAt <= (yield* Clock.currentTimeMillis)) {
            yield* update(key, (current, now) => current.settlement ? current : ({ ...current, nextAt: now, settlement: { type: "PromiseSettled", ref: current.request.ref, result: { status: "rejected", reason: { _tag: "PromiseTimedOut", deadlineAt } } } }))
          } else if (!entry.settlement) {
            const clock = entry.request.handle.executor === "clock" ? yield* Schema.decodeUnknownEffect(ClockHandle)(entry.request.handle) : undefined
            const result = clock
              ? { status: "fulfilled" as const, value: clock.value === undefined ? { at: clock.at } : clock.value }
              : (entry.request.mode ?? entry.request.handle.mode) === "push" && !entry.polling ? { status: "pending" as const }
              : yield* options.poll!(entry.request.handle).pipe(Effect.timeout(Math.max(1, Math.min(policy.attemptTimeoutMs, deadlineAt - (yield* Clock.currentTimeMillis)))))
            if (result.status !== "pending") yield* accept({ handle: entry.request.handle, result })
            else yield* update(key, (current, now) => ({ ...current, nextAt: current.settlement ? now : (current.request.mode ?? current.request.handle.mode) === "push" && !current.polling ? deadlineAt : Math.min(deadlineAt, now + policy.pollIntervalMs) }))
          }
          const latest = yield* io(() => storage.get<Entry>(key))
          if (!latest || latest.done || !latest.settlement) return
          const current = yield* decode(latest)
          yield* options.deliver(current.request.recipient, current.settlement!).pipe(Effect.timeout(policy.attemptTimeoutMs))
          yield* update(key, (current, now) => ({ request: current.request, done: true, nextAt: now + policy.retentionMs }))
        }).pipe(Effect.catch(error => update(key, (current, now) => ({ ...current, error: String(error), nextAt: current.settlement ? now + policy.retryIntervalMs : Math.min(deadlineAt, now + policy.retryIntervalMs) }))))
      }
      yield* discard
      yield* lock.withPermit(Effect.gen(function* () {
        if ((yield* io(() => storage.list({ limit: 1 }))).size === 0) {
          yield* makeAlarmScheduling(storage, options.alarms).delete
          yield* io(() => storage.deleteAll())
        }
      }).pipe(Effect.uninterruptible))
    }).pipe(Effect.mapError(RuntimeError.from)),
  }
}
