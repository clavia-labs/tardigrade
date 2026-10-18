import { decodeNodeChunks, textChunks, type NodeChunk } from "./chunks"
import type { RowWriter } from "../../collections/append-only"
import type { SqliteParameter } from "./store"

type Query = <Row>(statement: string, parameters?: readonly SqliteParameter[]) => readonly Row[]

// makeRowStorage stores append-only entries and version manifests in the caller's SQLite transaction (test/append-only.test.ts; test/workerd/append-only.workers.ts).
export function makeRowStorage(query: Query, chunkBytes: number) {
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS grove_value_rows(log TEXT NOT NULL,idx INTEGER NOT NULL,byte_length INTEGER NOT NULL,chunk_count INTEGER NOT NULL,payload BLOB,PRIMARY KEY(log,idx)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_row_chunks(log TEXT NOT NULL,idx INTEGER NOT NULL,ordinal INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(log,idx,ordinal)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_log_manifests(hash TEXT PRIMARY KEY,spans INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_log_spans(hash TEXT NOT NULL,ordinal INTEGER NOT NULL,log TEXT NOT NULL,end INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(hash,ordinal)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_log_versions_live(hash TEXT PRIMARY KEY) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_log_live(log TEXT PRIMARY KEY,until INTEGER NOT NULL) WITHOUT ROWID",
  ]) query(statement)
  const storage: RowWriter = {
    manifest: hash => {
      const header = query<{ spans: number }>("SELECT spans FROM grove_value_log_manifests WHERE hash=?", [hash])[0]
      if (!header) return undefined
      const rows = query<{ ordinal: number; log: string; end: number; bytes: number }>("SELECT ordinal,log,end,bytes FROM grove_value_log_spans WHERE hash=? ORDER BY ordinal", [hash])
      if (rows.length !== header.spans || rows.some((row, index) => row.ordinal !== index)) throw new Error("Invalid log version manifest")
      return rows.map(row => [row.log, row.end, row.bytes] as const)
    },
    length: log => query<{ size: number }>("SELECT COALESCE(MAX(idx)+1,0) size FROM grove_value_rows WHERE log=?", [log])[0]!.size,
    read: (log, start, end) => {
      if (start === end) return []
      const chunks = query<NodeChunk & { idx: number }>("SELECT r.idx,r.payload AS inline,c.ordinal,c.payload,r.byte_length,r.chunk_count FROM grove_value_rows r LEFT JOIN grove_value_row_chunks c ON r.payload IS NULL AND c.log=r.log AND c.idx=r.idx WHERE r.log=? AND r.idx>=? AND r.idx<? ORDER BY r.idx,c.ordinal", [log, start, end])
      const values: string[] = []
      for (let index = 0; index < chunks.length;) {
        const first = index, row = chunks[index]!
        if (row.idx !== start + values.length) throw new Error("Missing append-only row")
        while (index < chunks.length && chunks[index]!.idx === row.idx) index++
        values.push(decodeNodeChunks(chunks.slice(first, index)))
      }
      if (values.length !== end - start) throw new Error("Missing append-only rows")
      return values
    },
    insert: (log, index, text) => {
      const previous = query("SELECT idx FROM grove_value_rows WHERE log=? AND idx=?", [log, index])
      if (previous.length) {
        if (storage.read(log, index, index + 1)[0] !== text) throw new Error("Conflicting immutable append-only row")
        return
      }
      const pieces = textChunks(text, chunkBytes), size = Buffer.byteLength(text, "utf8")
      query("INSERT INTO grove_value_rows VALUES(?,?,?,?,?)", [log, index, size, pieces.length, pieces.length === 1 ? pieces[0]! : null])
      if (pieces.length > 1) pieces.forEach((piece, ordinal) => query("INSERT INTO grove_value_row_chunks VALUES(?,?,?,?)", [log, index, ordinal, piece]))
    },
    publish: (hash, spans) => {
      query("INSERT INTO grove_value_log_manifests VALUES(?,?)", [hash, spans.length])
      spans.forEach(([log, end, bytes], ordinal) => query("INSERT INTO grove_value_log_spans VALUES(?,?,?,?,?)", [hash, ordinal, log, end, bytes]))
    },
  }
  return {
    ...storage,
    collect: (heldParents: readonly string[]) => {
      const before = query<{ rows: number; bytes: number }>("SELECT COUNT(*) rows,COALESCE(SUM(byte_length),0) bytes FROM grove_value_rows")[0]!
      query("DELETE FROM grove_value_log_versions_live")
      query("INSERT INTO grove_value_log_versions_live SELECT hash FROM grove_value_log_manifests WHERE hash IN (SELECT hash FROM grove_value_gc_live)")
      for (const hash of heldParents) query("INSERT OR IGNORE INTO grove_value_log_versions_live VALUES(?)", [hash])
      query("DELETE FROM grove_value_log_spans WHERE hash NOT IN (SELECT hash FROM grove_value_log_versions_live)")
      query("DELETE FROM grove_value_log_manifests WHERE hash NOT IN (SELECT hash FROM grove_value_log_versions_live)")
      query("DELETE FROM grove_value_log_live")
      query("INSERT INTO grove_value_log_live SELECT log,MAX(end) FROM grove_value_log_spans GROUP BY log")
      query("DELETE FROM grove_value_row_chunks WHERE NOT EXISTS (SELECT 1 FROM grove_value_log_live l WHERE l.log=grove_value_row_chunks.log AND grove_value_row_chunks.idx<l.until)")
      query("DELETE FROM grove_value_rows WHERE NOT EXISTS (SELECT 1 FROM grove_value_log_live l WHERE l.log=grove_value_rows.log AND grove_value_rows.idx<l.until)")
      query("DELETE FROM grove_value_log_versions_live")
      query("DELETE FROM grove_value_log_live")
      const after = query<{ rows: number; bytes: number }>("SELECT COUNT(*) rows,COALESCE(SUM(byte_length),0) bytes FROM grove_value_rows")[0]!
      return { rows: before.rows - after.rows, bytes: before.bytes - after.bytes }
    },
  }
}
