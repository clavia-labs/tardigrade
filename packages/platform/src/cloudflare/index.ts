export { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
import { Effect, Exit } from "effect"
import { type ActorMethods, createThreadHost, type ThreadStorage } from "@clavia/tardigrade-core"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
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
}) {
  const connections = new Set<Effect.Effect<void, Error>>()
  const journal = <Entry extends object>(key: readonly string[]) => {
    const opened = cloudflareJournal<Entry>(options.storage, JSON.stringify(key), options.alarms)
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal([actor, instance, "supervisor"]),
    thread: coordinate => journal([coordinate.actor, coordinate.instance, "thread", coordinate.thread, "events"]),
    close: Effect.gen(function* () {
      const results = yield* Effect.forEach(connections, close => Effect.exit(close))
      connections.clear()
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  }
  return createThreadHost({ ...options, storage })
}

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })
export { cloudflarePromises, createCloudflareInbox, InboxCompletion, InboxNotification, type InboxStub } from "./inbox"

export { httpMessageTransport } from "../shared/http-message"
export { rpcMessageTransport, type ActorReceiver } from "../shared/rpc-message"
