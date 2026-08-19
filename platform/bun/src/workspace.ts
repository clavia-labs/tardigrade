import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { SqlClient } from "effect/unstable/sql"
import { WorkspaceSql, type SqlRunner } from "@clavia/tardigrade-code/workspace"

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

// The SQL surface behind workspace.sql: the model's own database, where it creates the tables a
// long run needs structure for (packages/code/src/workspace.ts). It is a database of its own,
// beside the log rather than inside it, because the log is append-only and this process is its one
// writer: a `DROP TABLE events` from a model that mistook its scratch space for its history would
// take the run's whole source of truth with it. Spilled values stay reachable through read and
// grep, which see a value whole whatever its size, and a consumer who wants the model querying the
// log's own database passes `workspaceSql: bunWorkspaceSql()` and accepts that reach (host.ts).

// BunWorkspaceSqlPolicy bounds one answer, so a query over a wide table cannot flood the turn's
// context: `rows` caps the row count and `bytes` caps their JSON, whichever comes first, and the
// answer says `truncated` when either cut it.
export interface BunWorkspaceSqlPolicy {
  readonly rows: number
  readonly bytes: number
}

export const DEFAULT_BUN_WORKSPACE_SQL_POLICY: BunWorkspaceSqlPolicy = { rows: 200, bytes: 32_768 }

export const bunWorkspaceSqlPolicyOf = (policy: Partial<BunWorkspaceSqlPolicy> = {}): BunWorkspaceSqlPolicy => ({
  rows: policy.rows ?? DEFAULT_BUN_WORKSPACE_SQL_POLICY.rows,
  bytes: policy.bytes ?? DEFAULT_BUN_WORKSPACE_SQL_POLICY.bytes
})

// DEFAULT_BUN_WORKSPACE_SQL_DOC is what the model is told about the surface `bunWorkspaceSql()`
// binds under the default host wiring: its own SQLite file, which starts empty. A consumer who
// points the surface at another database passes the `doc` that is true of it, and one who points it
// at the host's own client has `bunWorkspaceLogSqlDoc` for the tables that are already there.
export const DEFAULT_BUN_WORKSPACE_SQL_DOC =
  "The surface is SQLite, and the database is yours: it starts empty, holds the tables you CREATE, and lasts as long as the run's log does. Spilled values are held outside it, so read and grep are how you reach those."

// bunWorkspaceLogSqlDoc names the workspace store's own table, for a surface built over the host's
// client, where the log's database is the one the model queries. `id` is the ref a truncation
// pointed at and `value` is its JSON, so a row here is a spilled value; read and grep still see one
// whole whatever its size, which SQL over this table does not promise.
export const bunWorkspaceLogSqlDoc = (table: string = WORKSPACE_TABLE): string =>
  `This database is the run's own. ${table}(id, value, value_type) is the workspace store: id is a value's ref and value is its JSON. Use read and grep to see a spilled value whole, and SQL here for shape across them.`

// workspaceSqlFile is where the default surface's database lives: a sibling of the log, named after
// it, so the two files of one run travel together. A volatile log gets a volatile surface.
export const workspaceSqlFile = (log: string): string => {
  if (log === "" || log === ":memory:") return ":memory:"
  const dot = log.lastIndexOf(".")
  return dot > log.lastIndexOf("/") ? `${log.slice(0, dot)}.workspace${log.slice(dot)}` : `${log}.workspace`
}

// messageOf walks the cause chain, because the wrapper says only that a statement failed and the
// sentence the model needs ("no such table: notes") is the reason underneath it.
const messageOf = (error: unknown): string => {
  const said: Array<string> = []
  let at: unknown = error
  for (let depth = 0; at !== undefined && at !== null && depth < 4; depth += 1) {
    const message = (at as { message?: unknown }).message
    if (typeof message === "string" && message !== "" && !said.includes(message)) said.push(message)
    at = (at as { cause?: unknown }).cause
  }
  return said.length === 0 ? String(error) : said.join(": ")
}

const boundedBy = (policy: BunWorkspaceSqlPolicy, rows: ReadonlyArray<Record<string, unknown>>) => {
  const kept: Array<Record<string, unknown>> = []
  let bytes = 0
  for (const row of rows) {
    bytes += JSON.stringify(row)?.length ?? 0
    if (kept.length >= policy.rows || bytes > policy.bytes) return { rows: kept, truncated: true }
    kept.push(row)
  }
  return { rows: kept }
}

// bunWorkspaceSql binds the workspace's sql verb to the ambient SqlClient. A query that fails comes
// back as `{ error }` rather than as a failure, because a rejected statement is the model's next
// piece of information and it is the one who has to fix the SQL (packages/code/src/workspace.ts;
// host.test.ts, "a broken query answers an error the model can read").
export const bunWorkspaceSql = (
  options: Partial<BunWorkspaceSqlPolicy> & { readonly doc?: string } = {}
): Layer.Layer<never, never, SqlClient.SqlClient> => {
  const bounds = bunWorkspaceSqlPolicyOf(options)
  return Layer.effect(
    WorkspaceSql,
    Effect.map(
      SqlClient.SqlClient,
      (sql): SqlRunner => ({
        doc: options.doc ?? DEFAULT_BUN_WORKSPACE_SQL_DOC,
        sql: (query, params) =>
          sql.unsafe<Record<string, unknown>>(query, params).pipe(
            Effect.map((rows) => boundedBy(bounds, rows)),
            Effect.catch((error) => Effect.succeed({ error: messageOf(error) })),
            Effect.catchDefect((defect) => Effect.succeed({ error: messageOf(defect) }))
          )
      })
    )
  )
}
