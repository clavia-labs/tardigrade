import { Effect, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { WorkspaceError } from "@clavia/tardigrade-libraries/workspace/index"

export interface VirtualWorkspaceEntry {
  readonly path: string
  readonly kind: "file" | "directory" | "symlink" | "hardlink"
  readonly content: Uint8Array | null
  readonly target: string | null
  readonly mode: number
  readonly mtime: number
}

export interface VirtualWorkspaceSnapshot {
  readonly revision: number
  readonly entries: readonly VirtualWorkspaceEntry[]
}

export const DEFAULT_VIRTUAL_WORKSPACE_CHUNK_BYTES = 1024 * 1024

// sqliteWorkspaceStore commits complete snapshots only when their revision is current.
export const sqliteWorkspaceStore = (name: string, chunkBytes = DEFAULT_VIRTUAL_WORKSPACE_CHUNK_BYTES) => Effect.gen(function* () {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) return yield* Effect.fail(new WorkspaceError("storageChunkBytes must be a positive safe integer"))
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS virtual_workspaces (name TEXT PRIMARY KEY, revision INTEGER NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS virtual_workspace_entries (
    workspace TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
    content BLOB, target TEXT, mode INTEGER NOT NULL, mtime INTEGER NOT NULL,
    PRIMARY KEY (workspace, path)
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS virtual_workspace_file_chunks (
    workspace TEXT NOT NULL, path TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL,
    PRIMARY KEY (workspace, path, ordinal)
  )`
  yield* sql`INSERT INTO virtual_workspaces (name, revision) VALUES (${name}, 0) ON CONFLICT (name) DO NOTHING`
  return {
    metadata: sql<VirtualWorkspaceEntry>`SELECT path, kind, NULL AS content, target, mode, mtime FROM virtual_workspace_entries WHERE workspace = ${name} ORDER BY path`,
    content: (path: string) => Stream.unwrap(Effect.gen(function* () {
      const [entry] = yield* sql<{ kind: string; content: Uint8Array | null }>`SELECT kind, content FROM virtual_workspace_entries WHERE workspace = ${name} AND path = ${path}`
      if (!entry || entry.kind !== "file") return yield* Effect.fail(new WorkspaceError("Read requires a file"))
      const tail = Stream.paginate(1, ordinal => Effect.gen(function* () {
        const [chunk] = yield* sql<{ ordinal: number; payload: Uint8Array }>`SELECT ordinal, payload FROM virtual_workspace_file_chunks WHERE workspace = ${name} AND path = ${path} AND ordinal >= ${ordinal} ORDER BY ordinal LIMIT 1`
        if (!chunk) return [[], Option.none<number>()] as const
        if (chunk.ordinal !== ordinal) return yield* Effect.fail(new WorkspaceError(`Invalid file chunk sequence for ${path}`))
        return [[chunk.payload], Option.some(ordinal + 1)] as const
      }))
      return Stream.concat(Stream.succeed(entry.content ?? new Uint8Array()), tail)
    })).pipe(Stream.mapError(WorkspaceError.from)),
    load: sql.withTransaction(Effect.gen(function* () {
      const [row] = yield* sql<{ revision: number }>`SELECT revision FROM virtual_workspaces WHERE name = ${name}`
      if (!row) return yield* Effect.fail(new WorkspaceError("Workspace revision is missing"))
      const entries = yield* sql<VirtualWorkspaceEntry>`SELECT path, kind, content, target, mode, mtime FROM virtual_workspace_entries WHERE workspace = ${name} ORDER BY path`
      const chunks = yield* sql<{ path: string; ordinal: number; payload: Uint8Array }>`SELECT path, ordinal, payload FROM virtual_workspace_file_chunks WHERE workspace = ${name} ORDER BY path, ordinal`
      const byPath = new Map<string, Uint8Array[]>()
      for (const chunk of chunks) {
        const parts = byPath.get(chunk.path) ?? []
        if (chunk.ordinal !== parts.length + 1) return yield* Effect.fail(new WorkspaceError(`Invalid file chunk sequence for ${chunk.path}`))
        parts.push(chunk.payload)
        byPath.set(chunk.path, parts)
      }
      return { revision: row.revision, entries: entries.map(entry => {
        const tail = byPath.get(entry.path)
        if (!tail) return entry
        const parts = [entry.content ?? new Uint8Array(), ...tail]
        const content = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
        let offset = 0
        for (const part of parts) { content.set(part, offset); offset += part.byteLength }
        return { ...entry, content }
      }) } satisfies VirtualWorkspaceSnapshot
    })),
    commit: (snapshot: VirtualWorkspaceSnapshot) => sql.withTransaction(Effect.gen(function* () {
      const updated = yield* sql<{ revision: number }>`UPDATE virtual_workspaces SET revision = revision + 1 WHERE name = ${name} AND revision = ${snapshot.revision} RETURNING revision`
      if (updated.length !== 1) return yield* Effect.fail(new WorkspaceError(`Workspace ${name} changed during execution; retry the operation`))
      yield* sql`DELETE FROM virtual_workspace_file_chunks WHERE workspace = ${name}`
      yield* sql`DELETE FROM virtual_workspace_entries WHERE workspace = ${name}`
      for (const entry of snapshot.entries) {
        yield* sql`INSERT INTO virtual_workspace_entries (workspace, path, kind, content, target, mode, mtime) VALUES (${name}, ${entry.path}, ${entry.kind}, ${entry.content?.subarray(0, chunkBytes) ?? null}, ${entry.target}, ${entry.mode}, ${entry.mtime})`
        if (entry.content) for (let offset = chunkBytes, ordinal = 1; offset < entry.content.byteLength; offset += chunkBytes, ordinal++) {
          yield* sql`INSERT INTO virtual_workspace_file_chunks (workspace, path, ordinal, payload) VALUES (${name}, ${entry.path}, ${ordinal}, ${entry.content.subarray(offset, offset + chunkBytes)})`
        }
      }
    })),
  }
})
