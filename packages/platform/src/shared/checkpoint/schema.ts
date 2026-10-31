import atomPositionsMigration from "./migrations/003_atom_positions"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Migrator from "effect/unstable/sql/Migrator"
import { RuntimeError } from "@clavia/tardigrade-core"
import actorCheckpointMigration from "./migrations/001_actor_checkpoint"
import atomCheckpointsMigration from "./migrations/002_atom_checkpoints"

const CHECKPOINT_SQL_SCHEMA_VERSION = 3
const migrations = Migrator.fromRecord({
  "001_actor_checkpoint": actorCheckpointMigration,
  "002_atom_checkpoints": atomCheckpointsMigration,
  "003_atom_positions": atomPositionsMigration,
})
const loader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ migration_id: number }>`SELECT migration_id FROM checkpoint_migrations ORDER BY migration_id DESC LIMIT 1`.pipe(Effect.mapError(cause => new Migrator.MigrationError({ kind: "BadState", message: "Checkpoint migration metadata is unavailable", cause })))
  if (rows[0] && rows[0].migration_id > CHECKPOINT_SQL_SCHEMA_VERSION) return yield* new Migrator.MigrationError({ kind: "BadState", message: "Unsupported checkpoint SQL schema version", cause: new RuntimeError("Checkpoint migrations require a newer reader") })
  return yield* migrations
})

// initializeCheckpointSchema applies Effect SQL migrations before checkpoint access (test/properties/checkpoint/schema.ts).
export const initializeCheckpointSchema = Migrator.make({})({ table: "checkpoint_migrations", loader }).pipe(Effect.tap(() => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ migration_id: number }>`SELECT migration_id FROM checkpoint_migrations ORDER BY migration_id DESC LIMIT 1`
  if (rows[0]?.migration_id !== CHECKPOINT_SQL_SCHEMA_VERSION) return yield* Effect.fail(new RuntimeError("Checkpoint SQL migrations are incomplete"))
})), Effect.asVoid)
