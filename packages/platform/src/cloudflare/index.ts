export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
import { Effect, Exit, Fiber } from "effect"
import { createWatchdog, RuntimeError, watchdogKey, type WatchdogPolicy, type WatchdogTarget, type ActorMethods, createThreadHost, type ThreadStorage } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { cloudflareWatchdogStorage, cloudflareWatchdogTransaction } from "./watchdog"
import { sqlJournal } from "../shared/sql-journal"
export { sqlJournal } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
import { hostRoutes, type HttpHost } from "../shared/http"
import { HttpRouter } from "effect/unstable/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: CloudflareAlarmOptions = {}) {
  const alarms = makeRetryingAlarms(storage, options)
  return sqlJournal<Event>({
    actor,
    layer: SqliteClient.layer({ storage }),
    flush: alarms.sync,
  })
}

// createCloudflareHost keeps supervisor and thread journals in the supplied Durable Object storage.
export function createCloudflareHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
  readonly storage: DurableObjectStorage
  readonly alarms?: CloudflareAlarmOptions
  readonly watchdog?: { readonly policy?: Partial<WatchdogPolicy>; readonly retryable?: (error: Error) => boolean }
}) {
  let host!: ReturnType<typeof createThreadHost<Event, Services, State, Contracts>>
  const recoveries = new Set<Fiber.Fiber<void, Error>>()
  const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(options.storage, options.alarms), recover: target => host.recover(target), probe: target => host.probe(target), invalidate: target => host.invalidate(target),
    launch: work => Effect.sync(() => {
      const fiber = Effect.runFork(work)
      recoveries.add(fiber)
      fiber.addObserver(() => { recoveries.delete(fiber) })
    }), ...options.watchdog })
  const connections = new Set<Effect.Effect<void, Error>>()
  const journal = <Entry extends object>(key: readonly string[], target: WatchdogTarget) => {
    const alarms = makeRetryingAlarms(options.storage, options.alarms)
    const opened = sqlJournal<Entry>({ actor: JSON.stringify(key), layer: SqliteClient.layer({ storage: options.storage }), flush: alarms.sync,
      commit: (work, records, position) => Effect.gen(function* () {
        const context = yield* Effect.context<never>()
        yield* Effect.tryPromise({ try: () => options.storage.transaction(tx => Effect.runPromiseWith(context)(Effect.gen(function* () {
          yield* work
          if (!records.length) return
          let progressCursor = 0
          let admission = false
          for (const [index, record] of records.entries()) {
            const event: object = record.event
            if ("type" in event && (event.type === "EffectSettled" || event.type === "PromiseSettled")) progressCursor = position - records.length + index + 1
            if ("type" in event && (event.type === "MessageReceived" || event.type === "ThreadCreated" || event.type === "ThreadRequested")) admission = true
          }
          yield* watchdog.admit(cloudflareWatchdogTransaction(tx, options.alarms), target, progressCursor, admission)
        }))), catch: RuntimeError.from })
      }).pipe(Effect.uninterruptible),
    })
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal([actor, instance, "supervisor"], { actor, instance }),
    thread: coordinate => journal([coordinate.actor, coordinate.instance, "thread", coordinate.thread, "events"], coordinate),
    close: Effect.gen(function* () {
      const results = yield* Effect.forEach(connections, close => Effect.exit(close))
      connections.clear()
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  }
  host = createThreadHost({ ...options, storage, canDrive: target => watchdog.status.pipe(Effect.flatMap(entries => entries.get(watchdogKey(target))?.status === "blocked" ? Effect.succeed(false) : options.canDrive ? options.canDrive(target) : Effect.succeed(true))) })
  return { ...host, alarm: watchdog.alarm, watchdog, close: Effect.gen(function* () {
    yield* Effect.forEach(recoveries, Fiber.interrupt, { concurrency: "unbounded" })
    recoveries.clear()
    yield* host.close
  }) }
}

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })
export { cloudflarePromises, createCloudflarePromiseResolver, PromiseResolverCompletion, PromiseResolverNotification, type PromiseResolverStub } from "./promise-resolver"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
