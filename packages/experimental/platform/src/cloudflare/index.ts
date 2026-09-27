import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { sqlJournal } from "@clavia/tardigrade-experimental-host"

// cloudflareJournal commits to a Durable Object SQLite database and flushes before acknowledging an append.
export function cloudflareJournal<Event extends object>(storage: DurableObjectStorage, actor: string) {
  return sqlJournal<Event>({
    actor,
    layer: SqliteClient.layer({ storage }),
    flush: () => storage.sync(),
  })
}
