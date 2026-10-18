import type { Transaction } from "@tardie/grove/sqlite"

// initializeJournal binds a database to its journal and consolidates native materials (test/bun/journal.test.ts).
export function initializeJournal(tx: Transaction, identity: string) {
  const exists = (table: string) => tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]).length !== 0
  const legacy = ["stored_journal_checkpoints", "stored_journal_checkpoint_chunks", "stored_journal_inputs", "stored_journal_input_chunks", "stored_journal_collections", "stored_journal_message_indexes"]
  for (const table of ["experimental_events", "experimental_event_chunks", "experimental_messages", "checkpoint_trees", "effect_inputs", "effect_input_chunks", ...legacy]) {
    if (exists(table)) for (const order of ["ASC", "DESC"]) {
      const row = tx.execute(`SELECT actor FROM ${table} ORDER BY actor ${order} LIMIT 1`, [])[0]
      if (row && row.actor !== identity) throw new Error("A database must contain exactly one journal identity")
    }
  }
  tx.execute("CREATE TABLE IF NOT EXISTS journal_metadata(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,receipts_backfilled INTEGER NOT NULL DEFAULT 0 CHECK(receipts_backfilled IN (0,1)),checkpoints INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID", [])
  tx.execute("INSERT INTO journal_metadata(id,identity) VALUES(1,?) ON CONFLICT(id) DO NOTHING", [identity])
  if (tx.execute("SELECT identity FROM journal_metadata WHERE id=1", [])[0]!.identity !== identity) throw new Error("A database must contain exactly one journal identity")
  tx.execute("CREATE TABLE IF NOT EXISTS experimental_events(actor TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(actor,seq)) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS experimental_event_chunks(actor TEXT NOT NULL,seq INTEGER NOT NULL,ordinal INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(actor,seq,ordinal),FOREIGN KEY(actor,seq) REFERENCES experimental_events(actor,seq)) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS journal_accepted_inputs(ref TEXT PRIMARY KEY,input TEXT NOT NULL,byte_length INTEGER,chunk_count INTEGER,digest TEXT) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS journal_accepted_input_chunks(ref TEXT NOT NULL,ordinal INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(ref,ordinal)) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS journal_checkpoint_chunks(ordinal INTEGER PRIMARY KEY,payload BLOB NOT NULL) WITHOUT ROWID", [])
  tx.execute("CREATE TABLE IF NOT EXISTS journal_checkpoints(id INTEGER PRIMARY KEY CHECK(id=1),position INTEGER NOT NULL,payload BLOB NOT NULL,digest TEXT NOT NULL,byte_length INTEGER,chunk_count INTEGER) WITHOUT ROWID", [])
  for (const [source, target, columns] of [
    ["stored_journal_checkpoints", "journal_checkpoints", "position,payload,digest,byte_length,chunk_count"],
    ["stored_journal_checkpoint_chunks", "journal_checkpoint_chunks", "ordinal,payload"],
    ["stored_journal_inputs", "journal_accepted_inputs", "ref,input,byte_length,chunk_count,digest"],
    ["stored_journal_input_chunks", "journal_accepted_input_chunks", "ref,ordinal,payload"],
  ] as const) {
    if (!exists(source)) continue
    const fields = tx.execute(`PRAGMA table_info(${source})`, []).map(row => row.name)
    const selected = columns.split(",").map(column => fields.includes(column) ? column : "NULL").join(",")
    const singleton = target === "journal_checkpoints"
    tx.execute(`INSERT INTO ${target}(${singleton ? "id," : ""}${columns}) SELECT ${singleton ? "1," : ""}${selected} FROM ${source}`, [])
  }
  if (exists("stored_journal_collections")) tx.execute("UPDATE journal_metadata SET checkpoints=COALESCE((SELECT checkpoints FROM stored_journal_collections),0) WHERE id=1", [])
  if (exists("stored_journal_message_indexes")) tx.execute("UPDATE journal_metadata SET receipts_backfilled=EXISTS(SELECT 1 FROM stored_journal_message_indexes) WHERE id=1", [])
  for (const table of legacy) if (exists(table)) tx.execute(`DROP TABLE ${table}`, [])
}
