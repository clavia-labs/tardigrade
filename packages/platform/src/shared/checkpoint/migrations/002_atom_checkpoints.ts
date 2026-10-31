import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE checkpoint ADD COLUMN encoding INTEGER NOT NULL DEFAULT 0 CHECK (encoding IN (0, 1))`
  yield* sql`ALTER TABLE checkpoint ADD COLUMN storage_byte_length INTEGER`
  yield* sql`ALTER TABLE checkpoint ADD COLUMN storage_digest TEXT`
  yield* sql`CREATE TABLE atom_checkpoints (id INTEGER PRIMARY KEY, name TEXT NOT NULL, family TEXT, version TEXT, position INTEGER NOT NULL CHECK (position >= 0), byte_length INTEGER NOT NULL CHECK (byte_length > 0), chunk_count INTEGER NOT NULL CHECK (chunk_count > 0), digest TEXT NOT NULL, CHECK ((family IS NULL AND version IS NULL AND length(trim(name)) > 0) OR (family IS NOT NULL AND length(trim(family)) > 0 AND version IS NOT NULL AND length(trim(version)) > 0)))`
  yield* sql`CREATE UNIQUE INDEX atom_checkpoint_name ON atom_checkpoints (name) WHERE family IS NULL`
  yield* sql`CREATE UNIQUE INDEX atom_checkpoint_family ON atom_checkpoints (family, version, name) WHERE family IS NOT NULL`
  yield* sql`CREATE TABLE atom_checkpoint_chunks (atom_id INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), payload BLOB NOT NULL CHECK (typeof(payload) = 'blob' AND length(payload) > 0), PRIMARY KEY (atom_id, ordinal), FOREIGN KEY (atom_id) REFERENCES atom_checkpoints(id)) WITHOUT ROWID`
})
