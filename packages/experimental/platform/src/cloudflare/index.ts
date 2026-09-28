import { Effect } from "effect"
import { makeDurableObjectAlarms, type DurableObjectAlarmsOptions } from "@clavia/tardigrade-cloudflare/layers/alarms"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { sqlJournal } from "@clavia/tardigrade-experimental-host"
import { createThreadHost, type ThreadStorage } from "@clavia/tardigrade-experimental-host"
import { hostRoutes, type HttpHost } from "@clavia/tardigrade-experimental-host"
import { HttpRouter } from "effect/unstable/http"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string, options: DurableObjectAlarmsOptions = {}) {
  const alarms = makeDurableObjectAlarms(storage, options)
  return sqlJournal<Event>({
    actor,
    layer: SqliteClient.layer({ storage }),
    flush: () => Effect.runPromise(alarms.sync),
  })
}

// createCloudflareHost keeps supervisor, thread, and invocation journals in the supplied Durable Object storage.
export function createCloudflareHost<Event extends object, Services, Methods extends Readonly<Record<string, (...args: never[]) => Promise<void>>>, State>(options: Omit<Parameters<typeof createThreadHost<Event, Services, Methods, State>>[0], "storage"> & {
  readonly storage: DurableObjectStorage
  readonly alarms?: DurableObjectAlarmsOptions
}) {
  const connections = new Set<() => Promise<void>>()
  const journal = <Entry extends object>(key: readonly string[]) => {
    const opened = cloudflareJournal<Entry>(options.storage, JSON.stringify(key), options.alarms)
    connections.add(opened.close)
    return opened
  }
  const storage: ThreadStorage<Event> = {
    supervisor: (actor, instance) => journal([actor, instance, "supervisor"]),
    thread: coordinate => journal([coordinate.actor, coordinate.instance, "thread", coordinate.thread, "events"]),
    invocations: coordinate => journal([coordinate.actor, coordinate.instance, "thread", coordinate.thread, "invocations"]),
    close: async () => {
      const results = await Promise.allSettled([...connections].map(close => close()))
      connections.clear()
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, "Closing Cloudflare journals failed")
    },
  }
  return createThreadHost({ ...options, storage })
}

// cloudflareHandler exposes host routes as a Worker fetch handler; dispose releases HTTP resources.
export const cloudflareHandler = (host: HttpHost) => HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })
export { cloudflarePromises, createCloudflareInbox, InboxCompletion, InboxNotification, type InboxStub } from "./inbox"
