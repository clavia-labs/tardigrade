import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), position INTEGER NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL, tag TEXT)`
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(checkpoint)`
  if (!columns.some(column => column.name === "tag")) yield* sql`ALTER TABLE checkpoint ADD COLUMN tag TEXT`
  yield* sql`CREATE TABLE IF NOT EXISTS checkpoint_chunks (ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0), payload BLOB NOT NULL CHECK (typeof(payload) = 'blob' AND length(payload) > 0))`
})
