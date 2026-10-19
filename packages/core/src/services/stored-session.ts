import { decodeReference } from "@tardie/grove"
import type { SyncStore } from "@tardie/grove/sqlite"
import { encodedSession, type DocumentSession } from "./tree-state"

// storedSession adapts stored document references to projection lifetimes (platform/test/bun/journal.test.ts).
export function storedSession(store: SyncStore): DocumentSession {
  return { ...encodedSession(store, store.readValue), materialize: options => {
    const bound = store.materialize(options)
    return { ...bound, open: encoded => bound.open(decodeReference(encoded)) }
  } }
}
