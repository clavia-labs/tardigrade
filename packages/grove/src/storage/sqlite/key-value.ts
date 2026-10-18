import { decodeNodeChunks, textChunks, type NodeChunk } from "./chunks"
import type { MapSpan, MapWriter } from "../../collections/key-value"
import type { SqliteParameter } from "./store"

type Query = <Row>(statement: string, parameters?: readonly SqliteParameter[]) => readonly Row[]
interface Header { readonly key: string; readonly revision: number; readonly metadata: string }
const metadata = (branch: string, row: Header) => {
  const fields: unknown = JSON.parse(row.metadata), key: unknown = JSON.parse(row.key)
  if (typeof key !== "string" || !Array.isArray(fields) || fields.length !== 4 || fields.some(value => !Number.isSafeInteger(value) || value < 0) || fields[0] < 1 || fields[3] > 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 || (fields[3] === 1 ? fields[1] !== 0 || fields[2] !== 0 : fields[1] < 1 || fields[2] < 1)) throw new Error("Invalid key-value revision metadata")
  return { branch, key, revision: row.revision, order: fields[0] as number, bytes: fields[1] as number, chunks: fields[2] as number, deleted: fields[3] === 1 }
}

// makeMapStorage stores whole per-key revisions and collects versions invisible to retained snapshots (test/collections/key-value.ts; test/workerd/properties.workers.ts).
export function makeMapStorage(query: Query, chunkBytes: number) {
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS grove_map_rows(branch TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,metadata TEXT NOT NULL,payload BLOB,PRIMARY KEY(branch,key,revision)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_chunks(branch TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(branch,key,revision,ordinal)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_manifests(hash TEXT PRIMARY KEY,spans TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_heads(branch TEXT PRIMARY KEY,revision INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_versions_live(hash TEXT PRIMARY KEY) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_boundaries_live(branch TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(branch,revision)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_map_rows_live(branch TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(branch,key,revision)) WITHOUT ROWID",
  ]) query(statement)
  const storage: MapWriter = {
    manifest: hash => {
      const row = query<{ spans: string }>("SELECT spans FROM grove_map_manifests WHERE hash=?", [hash])[0]
      return row ? JSON.parse(row.spans) as readonly MapSpan[] : undefined
    },
    head: branch => query<{ revision: number }>("SELECT revision FROM grove_map_heads WHERE branch=?", [branch])[0]?.revision ?? 0,
    entry: (branch, revision, key) => {
      const row = query<Header>("SELECT key,revision,metadata FROM grove_map_rows WHERE branch=? AND key=? AND revision<=? ORDER BY revision DESC LIMIT 1", [branch, JSON.stringify(key), revision])[0]
      return row ? metadata(branch, row) : undefined
    },
    entries: (branch, revision, after, limit) => query<Header>(`SELECT r.key,r.revision,r.metadata FROM grove_map_rows r WHERE r.branch=? AND r.revision<=? ${after === undefined ? "" : "AND r.key>?"} AND NOT EXISTS (SELECT 1 FROM grove_map_rows n WHERE n.branch=r.branch AND n.key=r.key AND n.revision>r.revision AND n.revision<=?) ORDER BY r.key LIMIT ?`, after === undefined ? [branch, revision, revision, limit] : [branch, revision, JSON.stringify(after), revision, limit]).map(row => metadata(branch, row)),
    value: entry => {
      const rows = query<Header & { inline: NodeChunk["inline"]; ordinal: number | null; payload: NodeChunk["payload"] }>("SELECT r.key,r.revision,r.metadata,r.payload AS inline,c.ordinal,c.payload FROM grove_map_rows r LEFT JOIN grove_map_chunks c ON r.payload IS NULL AND c.branch=r.branch AND c.key=r.key AND c.revision=r.revision WHERE r.branch=? AND r.key=? AND r.revision=? ORDER BY c.ordinal", [entry.branch, JSON.stringify(entry.key), entry.revision])
      if (!rows.length) throw new Error("Missing key-value revision")
      const found = metadata(entry.branch, rows[0]!)
      if (found.deleted || found.bytes !== entry.bytes || found.order !== entry.order) throw new Error("Key-value revision metadata mismatch")
      return decodeNodeChunks(rows.map(row => ({ inline: row.inline, ordinal: row.ordinal, payload: row.payload, byte_length: found.bytes, chunk_count: found.chunks })))
    },
    insert: (branch, revision, key, change) => {
      const previous = storage.entry(branch, revision, key)
      if (previous?.revision === revision) {
        if (previous.order !== change.order || previous.deleted !== (change.text === null) || change.text !== null && storage.value(previous) !== change.text) throw new Error("Conflicting immutable key-value revision")
        return false
      }
      const pieces = change.text === null ? [] : textChunks(change.text, chunkBytes), size = change.text === null ? 0 : Buffer.byteLength(change.text)
      query("INSERT INTO grove_map_rows VALUES(?,?,?,?,?)", [branch, JSON.stringify(key), revision, JSON.stringify([change.order, size, pieces.length, Number(change.text === null)]), pieces.length === 1 ? pieces[0]! : null])
      if (pieces.length > 1) pieces.forEach((piece, ordinal) => query("INSERT INTO grove_map_chunks VALUES(?,?,?,?,?)", [branch, JSON.stringify(key), revision, ordinal, piece]))
      return true
    },
    publish: (hash, spans) => {
      query("INSERT INTO grove_map_manifests VALUES(?,?)", [hash, JSON.stringify(spans)])
      const last = spans.at(-1)
      if (last) query("INSERT INTO grove_map_heads VALUES(?,?) ON CONFLICT(branch) DO UPDATE SET revision=MAX(revision,excluded.revision)", last)
    },
  }
  return {
    ...storage,
    collect: (parents: readonly string[]) => {
      const size = () => query<{ rows: number; bytes: number }>("SELECT COUNT(*) rows,COALESCE(SUM(json_extract(metadata,'$[1]')),0) bytes FROM grove_map_rows")[0]!
      const before = size()
      query("DELETE FROM grove_map_versions_live")
      query("INSERT INTO grove_map_versions_live SELECT hash FROM grove_map_manifests WHERE hash IN (SELECT hash FROM grove_value_gc_live)")
      for (const hash of parents) query("INSERT OR IGNORE INTO grove_map_versions_live VALUES(?)", [hash])
      query("DELETE FROM grove_map_manifests WHERE hash NOT IN (SELECT hash FROM grove_map_versions_live)")
      query("DELETE FROM grove_map_boundaries_live")
      query("INSERT OR IGNORE INTO grove_map_boundaries_live SELECT json_extract(s.value,'$[0]'),json_extract(s.value,'$[1]') FROM grove_map_manifests m,json_each(m.spans) s")
      query("DELETE FROM grove_map_rows_live")
      query("INSERT OR IGNORE INTO grove_map_rows_live SELECT r.branch,r.key,MAX(r.revision) FROM grove_map_rows r JOIN grove_map_boundaries_live b ON b.branch=r.branch AND r.revision<=b.revision GROUP BY b.branch,b.revision,r.key")
      query("DELETE FROM grove_map_rows_live WHERE EXISTS (SELECT 1 FROM grove_map_rows r WHERE r.branch=grove_map_rows_live.branch AND r.key=grove_map_rows_live.key AND r.revision=grove_map_rows_live.revision AND json_extract(r.metadata,'$[3]')=1) AND NOT EXISTS (SELECT 1 FROM grove_map_rows_live older JOIN grove_map_rows r ON r.branch=older.branch AND r.key=older.key AND r.revision=older.revision WHERE older.branch=grove_map_rows_live.branch AND older.key=grove_map_rows_live.key AND older.revision<grove_map_rows_live.revision AND json_extract(r.metadata,'$[3]')=0) AND NOT EXISTS (SELECT 1 FROM grove_map_manifests m,json_each(m.spans) current_span,json_each(m.spans) prior_span JOIN grove_map_rows_live earlier ON earlier.branch=json_extract(prior_span.value,'$[0]') AND earlier.key=grove_map_rows_live.key AND earlier.revision<=json_extract(prior_span.value,'$[1]') JOIN grove_map_rows r ON r.branch=earlier.branch AND r.key=earlier.key AND r.revision=earlier.revision WHERE json_extract(current_span.value,'$[0]')=grove_map_rows_live.branch AND prior_span.key<current_span.key AND json_extract(r.metadata,'$[3]')=0)")
      query("DELETE FROM grove_map_chunks WHERE NOT EXISTS (SELECT 1 FROM grove_map_rows_live l WHERE l.branch=grove_map_chunks.branch AND l.key=grove_map_chunks.key AND l.revision=grove_map_chunks.revision)")
      query("DELETE FROM grove_map_rows WHERE NOT EXISTS (SELECT 1 FROM grove_map_rows_live l WHERE l.branch=grove_map_rows.branch AND l.key=grove_map_rows.key AND l.revision=grove_map_rows.revision)")
      query("DELETE FROM grove_map_heads WHERE branch NOT IN (SELECT branch FROM grove_map_boundaries_live)")
      query("DELETE FROM grove_map_rows_live"); query("DELETE FROM grove_map_boundaries_live"); query("DELETE FROM grove_map_versions_live")
      const after = size()
      return { rows: before.rows - after.rows, bytes: before.bytes - after.bytes }
    },
  }
}
