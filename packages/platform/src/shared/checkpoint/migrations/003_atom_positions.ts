import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE atom_checkpoints ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))`
  yield* sql`DROP INDEX atom_checkpoint_name`
  yield* sql`DROP INDEX atom_checkpoint_family`
  yield* sql`CREATE UNIQUE INDEX atom_checkpoint_name ON atom_checkpoints (name, position) WHERE family IS NULL`
  yield* sql`CREATE UNIQUE INDEX atom_checkpoint_family ON atom_checkpoints (family, version, name, position) WHERE family IS NOT NULL`
  yield* sql`UPDATE atom_checkpoints SET pinned = 1 WHERE family IS NULL AND position = (SELECT position FROM checkpoint WHERE id = 1 AND encoding = 1)`
})
