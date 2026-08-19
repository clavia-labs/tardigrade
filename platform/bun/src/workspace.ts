import type { Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { SqlClient } from "effect/unstable/sql"

// The durable workspace on bun: Effect's SQL-backed KeyValueStore over the same SqlClient the log
// uses, so a spilled value outlives the process that wrote it and replay hydrates a ref from disk
// (host.test.ts, "a value spilled before a restart hydrates from disk, manifest and all"). The
// values live in the log's own database file because the event that points at a ref and the value
// it points at are one artifact: copying, moving, or deleting a run can never take one and leave
// the other.

// WORKSPACE_TABLE is the table the workspace values and the ref manifest live in. It is a parameter
// because two isolated workspaces over one database are two tables.
export const WORKSPACE_TABLE = "workspace"

// bunWorkspace is the workspace layer createBunHost provides by default. It creates its table on
// build, and it spans the whole database: what one workspace covers is the platform's call
// (packages/code/src/store.ts), and a consumer that wants a narrower span hands the host its own
// layer, over another table or over a prefixed view of this one.
export const bunWorkspace = (
  table: string = WORKSPACE_TABLE
): Layer.Layer<KeyValueStore.KeyValueStore, never, SqlClient.SqlClient> => KeyValueStore.layerSql({ table })
