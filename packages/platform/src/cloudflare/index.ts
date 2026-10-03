export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
export { executionStreamSse } from "../shared/execution-stream-sse"
import { Context, Effect, Exit, Fiber } from "effect"
import { DurableObject } from "cloudflare:workers"
import { createWatchdog, RuntimeError, watchdogKey, type WatchdogPolicy, type WatchdogTarget, type ActorMethods, createThreadHost, type ThreadStorage } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { cloudflareWatchdogStorage, cloudflareWatchdogTransaction } from "./watchdog"
import { sqlJournal } from "../shared/sql-journal"
export { sqlJournal } from "../shared/sql-journal"
export { hostRoutes, type HttpHost } from "../shared/http"
import { hostRoutes, type HttpHost } from "../shared/http"
import { methodHttp } from "../shared/method-http"
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

// createActorHost keeps supervisor and thread journals in the supplied Durable Object storage.
export function createActorHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "storage"> & {
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

/** @deprecated Use createActorHost for new Cloudflare hosts. */
export const createCloudflareHost = createActorHost

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })

type ActorHostOptions<Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Parameters<typeof createActorHost<Event, Services, State, Contracts>>[0]

type ActorObjectOptions<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Omit<ActorHostOptions<Event, Services, State, Contracts>, "storage" | "actorContext" | "services"> & {
  readonly actorContext?: ActorHostOptions<Event, Services, State, Contracts>["actorContext"]
  readonly services: (env: Env, ...args: Parameters<ActorHostOptions<Event, Services, State, Contracts>["services"]>) => ReturnType<ActorHostOptions<Event, Services, State, Contracts>["services"]>
}

// createActorObject supplies the Durable Object lifecycle required by a Tardigrade actor host.
export function createActorObject<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  const actorContext = options.actorContext ?? (() => Context.empty()) as unknown as NonNullable<ActorHostOptions<Event, Services, State, Contracts>["actorContext"]>
  return class ActorObject extends DurableObject<Env> {
    private readonly host = createActorHost({ ...options, actorContext, services: (coordinate, runtime) => options.services(this.env, coordinate, runtime), storage: this.ctx.storage })
    private readonly http = cloudflareHandler(this.host)
    private readonly methods = methodHttp(this.host)

    fetch(request: Request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/healthz" || pathname === "/v1/methods" || pathname === "/v1/metadata" || pathname.includes("/methods/")) return this.methods(request)
      return this.http.handler(request)
    }

    async alarm() {
      await Effect.runPromise(this.host.alarm)
    }

    async dispose() {
      await Effect.runPromise(this.host.close)
      await this.http.dispose()
    }
  }
}

// createActorWorker routes public actor requests to the Durable Object class created by createActorObject.
export function createActorWorker<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  const ActorObject = createActorObject<Env, Event, Services, State, Contracts>(options)
  return {
    ActorObject,
    fetch(request: Request, env: Env & { readonly ACTORS: DurableObjectNamespace<InstanceType<typeof ActorObject>> }) {
      const instance = /^\/v1\/actors\/([^/]+)\/threads(?:\/|$)/.exec(new URL(request.url).pathname)?.[1]
      if (!instance) return new Response("Not found", { status: 404 })
      return env.ACTORS.getByName(decodeURIComponent(instance)).fetch(request)
    },
  }
}
export { cloudflarePromises, createCloudflarePromiseResolver, PromiseResolverCompletion, PromiseResolverNotification, type PromiseResolverStub } from "./promise-resolver"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
