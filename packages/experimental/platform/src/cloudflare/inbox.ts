import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { isDeepStrictEqual } from "node:util"
import { Effect, Layer, Schema } from "effect"
import { ClockHandle, ExecutionHandle, RuntimeError, type ThreadCoordinate } from "@clavia/tardigrade-experimental-core"
import { Promises, Resolution, ResolutionRegistration, registrationKey, promisePolicy, type ResolutionPoll, type PromisePolicy } from "@clavia/tardigrade-experimental-host"

export interface InboxStub {
  readonly watch: (request: ResolutionRegistration) => Promise<void>
  readonly cancel: (request: ResolutionRegistration) => Promise<void>
}

// cloudflarePromises binds an actor's promise service to an Inbox DO; registration acknowledges durable acceptance by that DO.
export function cloudflarePromises(options: { readonly recipient: ThreadCoordinate; readonly target: InboxStub; readonly policy?: Partial<PromisePolicy> }) {
  const policy = promisePolicy(options.policy)
  const invoke = (method: "watch" | "cancel", request: Parameters<typeof Promises.Service.watch>[0]) => Effect.tryPromise({
    try: () => options.target[method]({ ...request, recipient: options.recipient }),
    catch: RuntimeError.from,
  }).pipe(Effect.timeout(policy.attemptTimeoutMs))
  return Layer.succeed(Promises, { watch: request => invoke("watch", request), cancel: request => invoke("cancel", request) })
}

export const InboxCompletion = Schema.Struct({ handle: ExecutionHandle, result: Resolution.fields.result })
export type InboxCompletion = typeof InboxCompletion.Type
const Entry = Schema.Struct({
  request: ResolutionRegistration, nextAt: Schema.NullOr(Schema.Finite), done: Schema.Boolean,
  settlement: Schema.optionalKey(Resolution), error: Schema.optionalKey(Schema.String),
})
type Entry = typeof Entry.Type
const Incoming = Schema.Struct({ handle: ExecutionHandle, result: Schema.optionalKey(Resolution.fields.result), expiresAt: Schema.Finite })
type Incoming = typeof Incoming.Type
const prefix = "inbox:job:"
const incomingPrefix = "inbox:result:"
const handleKey = (handle: ExecutionHandle) => JSON.stringify([handle.executor, handle.id, handle.endpoint ?? null, handle.at ?? null])

// createCloudflareInbox owns a dedicated DO's storage; acknowledged payloads are discarded and deduplication receipts expire by policy.
export function createCloudflareInbox(options: {
  readonly storage: DurableObjectStorage
  readonly poll?: ResolutionPoll
  readonly deliver: (recipient: ThreadCoordinate, settlement: Resolution) => Effect.Effect<void, Error>
  readonly verifyWebhook?: (request: Request) => Effect.Effect<InboxCompletion, Error>
  readonly policy?: Partial<PromisePolicy>
}) {
  const policy = promisePolicy(options.policy)
  const storage = options.storage
  const decode = Schema.decodeUnknownSync(Entry)
  let pending: Promise<unknown> = Promise.resolve()
  // mutate serializes storage changes, including deletion, without holding a lock across network requests.
  const mutate = <Value>(run: () => Promise<Value>): Promise<Value> => {
    const next = pending.then(run, run)
    pending = next.catch(() => {})
    return next
  }
  const schedule = async (tx: Pick<DurableObjectStorage, "list" | "setAlarm" | "deleteAlarm">) => {
    const jobs = await tx.list<Entry>({ prefix })
    const results = await tx.list<Incoming>({ prefix: incomingPrefix })
    const times = [...jobs.values()].map(value => decode(value).nextAt).filter((time): time is number => time !== null)
    times.push(...[...results.values()].map(value => Schema.decodeSync(Incoming)(value).expiresAt))
    if (!times.length) await tx.deleteAlarm()
    else await tx.setAlarm(times.reduce((first, time) => Math.min(first, time)))
  }
  const update = (key: string, change: (entry: Entry) => Entry) => mutate(() => storage.transaction(async tx => {
    const value = await tx.get<Entry>(key)
    if (value && !decode(value).done) await tx.put(key, change(decode(value)))
    await schedule(tx)
  }))
  const register = (input: ResolutionRegistration, cancelled: boolean) => mutate(() => storage.transaction(async tx => {
    const request = Schema.decodeSync(ResolutionRegistration)(input)
    const key = prefix + registrationKey(request)
    const raw = await tx.get<Entry>(key)
    const previous = raw && decode(raw)
    if (previous && !isDeepStrictEqual(previous.request, request)) throw new RuntimeError("Promise reference already registered with another handle")
    if (cancelled) await tx.put(key, { request, done: true, nextAt: Date.now() + policy.retentionMs } satisfies Entry)
    else if (!previous) {
      const clock = request.handle.executor === "clock" ? Schema.decodeUnknownSync(ClockHandle)(request.handle) : undefined
      if (!clock && request.mode !== "push" && !options.poll) throw new RuntimeError("Inbox has no polling adapter; use push mode")
      const incoming = await tx.get<Incoming>(incomingPrefix + handleKey(request.handle))
      const result = incoming && incoming.expiresAt > Date.now() ? incoming.result : undefined
      await tx.put(key, {
        request, done: false, nextAt: result ? Date.now() : clock ? Math.max(Date.now(), clock.at) : request.mode !== "push" ? Date.now() : null,
        ...(result ? { settlement: { type: "PromiseSettled", ref: request.ref, result } as Resolution } : {}),
      } satisfies Entry)
    }
    await schedule(tx)
  }))
  // accept receives trusted completions from RPC or an authenticated webhook adapter and retains early arrivals.
  const accept = (input: InboxCompletion) => mutate(() => storage.transaction(async tx => {
    const completion = Schema.decodeSync(InboxCompletion)(input)
    const id = handleKey(completion.handle)
    const key = incomingPrefix + id
    const previous = await tx.get<Incoming>(key)
    if (previous && previous.expiresAt > Date.now() && previous.result && !isDeepStrictEqual(previous.result, completion.result)) throw new RuntimeError("Conflicting inbox completion")
    const entries = await tx.list<Entry>({ prefix })
    const matching = [...entries].filter(([, value]) => handleKey(value.request.handle) === id)
    let needed = matching.length === 0
    for (const [jobKey, value] of matching) {
      const entry = decode(value)
      if (entry.done) continue
      needed = true
      if (entry.settlement && !isDeepStrictEqual(entry.settlement.result, completion.result)) throw new RuntimeError("Conflicting inbox completion")
      await tx.put(jobKey, { ...entry, nextAt: Date.now(), settlement: { type: "PromiseSettled", ref: entry.request.ref, result: completion.result } } satisfies Entry)
    }
    await tx.put(key, { handle: completion.handle, ...(needed ? { result: completion.result } : {}), expiresAt: (previous && previous.expiresAt > Date.now() ? previous.expiresAt : Date.now() + policy.retentionMs) } satisfies Incoming)
    await schedule(tx)
  }))
  const discard = () => mutate(() => storage.transaction(async tx => {
    const jobs = await tx.list<Entry>({ prefix })
    for (const [key, raw] of jobs) {
      const entry = decode(raw)
      if (entry.done && entry.nextAt !== null && entry.nextAt <= Date.now()) { await tx.delete(key); jobs.delete(key) }
    }
    for (const [key, raw] of await tx.list<Incoming>({ prefix: incomingPrefix })) {
      const incoming = Schema.decodeSync(Incoming)(raw)
      if (incoming.expiresAt <= Date.now()) await tx.delete(key)
      else if (incoming.result && ![...jobs.values()].some(entry => !entry.done && handleKey(entry.request.handle) === handleKey(incoming.handle)) && [...jobs.values()].some(entry => handleKey(entry.request.handle) === handleKey(incoming.handle))) {
        await tx.put(key, { handle: incoming.handle, expiresAt: incoming.expiresAt } satisfies Incoming)
      }
    }
    await schedule(tx)
  }))
  return {
    watch: (request: ResolutionRegistration) => register(request, false),
    cancel: async (request: ResolutionRegistration) => { await register(request, true); await discard() },
    accept,
    webhook: async (request: Request): Promise<Response> => {
      if (!options.verifyWebhook) return new Response("Webhook adapter not configured", { status: 404 })
      const verified = await Effect.runPromise(options.verifyWebhook(request).pipe(Effect.timeout(policy.attemptTimeoutMs), Effect.result))
      if (verified._tag === "Failure") return new Response("Invalid webhook", { status: 401 })
      try { await accept(verified.success); return new Response(null, { status: 204 }) }
      catch { return new Response("Completion not accepted", { status: 503 }) }
    },
    alarm: async () => {
      await discard()
      for (const [key, raw] of await storage.list<Entry>({ prefix })) {
        let entry = decode(raw)
        if (entry.done || entry.nextAt === null || entry.nextAt > Date.now()) continue
        await update(key, current => ({ ...current, nextAt: Date.now() + policy.retryIntervalMs }))
        try {
          if (!entry.settlement) {
            const clock = entry.request.handle.executor === "clock" ? Schema.decodeUnknownSync(ClockHandle)(entry.request.handle) : undefined
            const result = clock
              ? { status: "fulfilled" as const, value: { at: clock.at } }
              : await Effect.runPromise(options.poll!(entry.request.handle).pipe(Effect.timeout(policy.attemptTimeoutMs)))
            if (result.status !== "pending") await accept({ handle: entry.request.handle, result })
            else await update(key, current => ({ ...current, nextAt: current.settlement ? Date.now() : Date.now() + policy.pollIntervalMs }))
          }
          const latest = await storage.get<Entry>(key)
          if (!latest || latest.done || !latest.settlement) continue
          entry = decode(latest)
          await Effect.runPromise(options.deliver(entry.request.recipient, entry.settlement!).pipe(Effect.timeout(policy.attemptTimeoutMs)))
          await update(key, current => ({ request: current.request, done: true, nextAt: Date.now() + policy.retentionMs }))
        } catch (error) {
          await update(key, current => ({ ...current, error: String(error), nextAt: Date.now() + policy.retryIntervalMs }))
        }
      }
      await discard()
      await mutate(async () => {
        if ((await storage.list({ limit: 1 })).size === 0) {
          await storage.deleteAlarm()
          await storage.deleteAll()
        }
      })
    },
  }
}
