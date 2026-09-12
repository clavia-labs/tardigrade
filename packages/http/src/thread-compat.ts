import { Effect } from "effect"
import type { ActorThreads } from "./threads"

import { publicThreadId, resolveThreadId } from "@clavia/tardigrade-host/thread-compat"
export { publicThreadId, resolveThreadId } from "@clavia/tardigrade-host/thread-compat"

// withLegacyThreadIds adapts public operations without changing stored addresses or actor selection (thread-compat.test.ts).
export const withLegacyThreadIds = (threads: ActorThreads): ActorThreads => {
  const resolve = (id: string) => resolveThreadId(id, (thread) => Effect.map(threads.actorThread(thread), (record) => record !== undefined))
  return {
    ...threads,
    append: (id, event) => Effect.flatMap(resolve(id), (thread) => threads.append(thread, event)),
    appendUnlessKeyPresent: (id, event, key) =>
      Effect.flatMap(resolve(id), (thread) => threads.appendUnlessKeyPresent(thread, event, key)),
    events: (id) => Effect.flatMap(resolve(id), threads.events),
    eventsPage: (id, mark, limit) => Effect.flatMap(resolve(id), (thread) => threads.eventsPage(thread, mark, limit)),
    awaitHead: (id, mark) => Effect.flatMap(resolve(id), (thread) => threads.awaitHead(thread, mark)),
    list: Effect.map(threads.list, (entries) => {
      const names = new Set<string>()
      return entries.map(({ id: thread, events }) => {
        const id = publicThreadId(thread)
        if (names.has(id)) throw new Error(`ambiguous public thread id ${JSON.stringify(id)}: multiple stored addresses exist`)
        names.add(id)
        return { id, events }
      })
    })
  }
}
