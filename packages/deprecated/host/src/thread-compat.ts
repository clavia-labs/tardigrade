import { Effect } from "effect"

const LEGACY_PREFIX = "ag."

// publicThreadId preserves legacy public names and exposes other thread identifiers unchanged (thread-compat.test.ts).
export const publicThreadId = (thread: string): string =>
  thread.startsWith(LEGACY_PREFIX) ? thread.slice(LEGACY_PREFIX.length) : thread

// resolveThreadId resolves existing legacy names and preserves supplied IDs for new threads (thread-compat.test.ts).
export const resolveThreadId = (id: string, exists: (thread: string) => Effect.Effect<boolean>): Effect.Effect<string> =>
  Effect.gen(function*() {
    const legacy = `${LEGACY_PREFIX}${id}`
    const registeredLegacy = yield* exists(legacy)
    const registeredExact = yield* exists(id)
    if (registeredLegacy && registeredExact) {
      return yield* Effect.die(new Error(`ambiguous public thread id ${JSON.stringify(id)}: both stored addresses exist`))
    }
    return registeredLegacy ? legacy : id
  })

