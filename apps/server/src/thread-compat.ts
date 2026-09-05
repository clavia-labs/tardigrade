import { Effect } from "effect"
import type { ActorThreads } from "./host"

const LEGACY_PREFIX = "ag."

// publicThreadId preserves legacy public names and exposes other thread identifiers unchanged (thread-compat.test.ts).
export const publicThreadId = (thread: string): string =>
  thread.startsWith(LEGACY_PREFIX) ? thread.slice(LEGACY_PREFIX.length) : thread

// resolveThreadId resolves registered public names and retains legacy placement for new HTTP threads (thread-compat.test.ts).
export const resolveThreadId = (id: string, exists: (thread: string) => Effect.Effect<boolean>): Effect.Effect<string> =>
  Effect.gen(function*() {
    const legacy = `${LEGACY_PREFIX}${id}`
    const registeredLegacy = yield* exists(legacy)
    const registeredExact = yield* exists(id)
    if (registeredLegacy && registeredExact) {
      return yield* Effect.die(new Error(`ambiguous public thread id ${JSON.stringify(id)}: both stored addresses exist`))
    }
    return registeredLegacy || !registeredExact ? legacy : id
  })

// withLegacyThreadIds adapts public operations without changing stored addresses or actor selection (thread-compat.test.ts).
export const withLegacyThreadIds = (threads: ActorThreads): ActorThreads => {
  const resolve = (id: string) => resolveThreadId(id, (thread) => Effect.map(threads.actorThread(thread), (record) => record !== undefined))
  return {
    ...threads,
    append: (id, event) => Effect.flatMap(resolve(id), (thread) => threads.append(thread, event)),
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
