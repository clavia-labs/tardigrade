import assert from "node:assert/strict"
import { Effect } from "effect"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { checkpointDigest, encodeCheckpoint, effectKey } from "@clavia/tardigrade-core"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import fixture from "../fixtures/migration/050-snapshot.json"

const alarm = { set: () => Effect.void, clear: Effect.void }
const scheduler = { alarm, deliver: () => Effect.void }

// databaseIdentity checks durable journal binding before and after the first event (integration.ts).
export async function databaseIdentity(driver: SyncSqlite, value: { identity: string; written: boolean }) {
  const identity = "journal:" + value.identity
  let journal = synchronousJournal({ driver, actor: identity, scheduler })
  try {
    if (value.written) await Effect.runPromise(journal.append(0, [{ event: { type: "Recorded" } }]))
    await Effect.runPromise(journal.close)
    const before = driver.execute("SELECT * FROM experimental_events", [])
    assert.throws(() => synchronousJournal({ driver, actor: identity + ":other" }), /one journal identity/)
    assert.deepEqual(driver.execute("SELECT * FROM experimental_events", []), before)
    journal = synchronousJournal({ driver, actor: identity, scheduler })
    assert.deepEqual(await Effect.runPromise(journal.read), value.written ? [{ event: { type: "Recorded" } }] : [])
    for (const table of ["journal_metadata", "journal_checkpoints", "journal_checkpoint_chunks", "journal_accepted_inputs", "journal_accepted_input_chunks", "runtime_wakes", "runtime_generation", "runtime_watchdogs"]) {
      assert(!driver.execute(`PRAGMA table_info(${table})`, []).some(row => row.name === "actor"))
    }
    assert.throws(() => driver.execute("INSERT INTO journal_metadata(id,identity) VALUES(2,?)", [identity]))
    assert.throws(() => driver.execute("INSERT INTO journal_checkpoints(id,position,payload,digest) VALUES(2,0,?,'')", [new Uint8Array()]))
    assert.throws(() => driver.execute("INSERT INTO runtime_generation(id,value) VALUES(2,0)", []))
  } finally { await Effect.runPromise(journal.close) }
}

// nativeMaterialMigration preserves journal bytes and recovery records across rollback, conversion and reopen (integration.ts).
export async function nativeMaterialMigration(driver: SyncSqlite, value: { text: string; rollback: boolean; multiple: boolean; chunked: boolean }) {
  const execute = driver.execute.bind(driver), actor = "events", ref = fixture.ref
  const input = { ref, request: { act: ref.act, input: { text: value.text } } }
  const payload = encodeCheckpoint({ position: 1, durable: [{ name: "inline", state: value.text, position: 1 }], operations: [] })
  const digest = await Effect.runPromise(checkpointDigest(payload))
  execute("CREATE TABLE experimental_events(actor TEXT,seq INTEGER,event TEXT,PRIMARY KEY(actor,seq))", [])
  execute("INSERT INTO experimental_events VALUES(?,0,?)", [actor, JSON.stringify({ event: { type: "Recorded", text: value.text } })])
  execute("CREATE TABLE stored_journal_inputs(actor TEXT,ref TEXT,input TEXT,PRIMARY KEY(actor,ref))", [])
  execute("INSERT INTO stored_journal_inputs VALUES(?,?,?)", [actor, effectKey(ref), JSON.stringify(input)])
  execute("CREATE TABLE stored_journal_checkpoints(actor TEXT PRIMARY KEY,position INTEGER,payload BLOB,digest TEXT)", [])
  execute("INSERT INTO stored_journal_checkpoints VALUES(?,1,?,?)", [actor, payload, digest])
  if (value.chunked) {
    for (const [header, chunks, bytes] of [
      ["stored_journal_checkpoints", "stored_journal_checkpoint_chunks", payload],
      ["stored_journal_inputs", "stored_journal_input_chunks", new TextEncoder().encode(JSON.stringify(input))],
    ] as const) {
      const accepted = header === "stored_journal_inputs"
      execute(`ALTER TABLE ${header} ADD COLUMN byte_length INTEGER`, [])
      execute(`ALTER TABLE ${header} ADD COLUMN chunk_count INTEGER`, [])
      if (accepted) execute(`ALTER TABLE ${header} ADD COLUMN digest TEXT`, [])
      execute(`CREATE TABLE ${chunks}(actor TEXT,${accepted ? "ref TEXT," : ""}ordinal INTEGER,payload BLOB,PRIMARY KEY(actor,${accepted ? "ref," : ""}ordinal))`, [])
      execute(`UPDATE ${header} SET ${accepted ? "input" : "payload"}=?,byte_length=?,chunk_count=?,digest=?`, [accepted ? "" : new Uint8Array(), bytes.byteLength, Math.ceil(bytes.byteLength / 7), await Effect.runPromise(checkpointDigest(bytes))])
      for (let offset = 0; offset < bytes.byteLength; offset += 7) execute(`INSERT INTO ${chunks} VALUES(${accepted ? "?,?,?,?" : "?,?,?"})`, [actor, ...(accepted ? [effectKey(ref)] : []), offset / 7, bytes.slice(offset, offset + 7)])
    }
  }
  execute("CREATE TABLE stored_journal_collections(actor TEXT PRIMARY KEY,checkpoints INTEGER)", [])
  execute("INSERT INTO stored_journal_collections VALUES(?,7)", [actor])
  execute("CREATE TABLE stored_scheduler_wakes(actor TEXT,id TEXT,entry TEXT,PRIMARY KEY(actor,id))", [])
  execute("INSERT INTO stored_scheduler_wakes VALUES('recovery',?,?)", [fixture.recovery.wake.id, JSON.stringify(fixture.recovery.wake)])
  execute("CREATE TABLE stored_scheduler_generation(actor TEXT PRIMARY KEY,value INTEGER)", [])
  execute("INSERT INTO stored_scheduler_generation VALUES('recovery',?)", [fixture.recovery.generation])
  execute("CREATE TABLE stored_watchdog_entries(actor TEXT,id TEXT,entry TEXT,PRIMARY KEY(actor,id))", [])
  execute("INSERT INTO stored_watchdog_entries VALUES('recovery',?,?)", [fixture.recovery.key, JSON.stringify(fixture.recovery.watchdog)])
  if (value.multiple) {
    if (value.chunked) execute("INSERT INTO stored_watchdog_entries VALUES('other','foreign','{}')", [])
    else execute("INSERT INTO experimental_events VALUES('other',0,'{}')", [])
  }
  const before = execute("SELECT * FROM experimental_events ORDER BY actor,seq", [])
  const checkpointBefore = execute("SELECT * FROM stored_journal_checkpoints", [])
  let fail = value.rollback
  const faulting: SyncSqlite = { ...driver, execute: (sql, args) => {
    if (fail && sql === "DROP TABLE stored_watchdog_entries") throw new Error("Injected conversion failure")
    return execute(sql, args)
  } }
  const open = () => synchronousJournal({ driver: faulting, actor, scheduler, collectEvery: 8 })
  if (value.multiple || fail) {
    assert.throws(open, value.multiple ? /exactly one/ : /Injected/)
    assert.deepEqual(execute("SELECT * FROM experimental_events ORDER BY actor,seq", []), before)
    assert.deepEqual(execute("SELECT * FROM stored_journal_checkpoints", []), checkpointBefore)
    assert.equal(execute("SELECT name FROM sqlite_master WHERE name IN ('journal_metadata','runtime_wakes')", []).length, 0)
    if (value.multiple) return
    fail = false
  }
  let journal = open()
  try {
    assert.deepEqual((await Effect.runPromise(journal.readCheckpoint))!.payload, payload)
    assert.deepEqual(await Effect.runPromise(journal.readInputs), [input])
    assert.deepEqual(execute("SELECT * FROM experimental_events ORDER BY actor,seq", []), before)
    assert.deepEqual(execute("SELECT checkpoints,receipts_backfilled FROM journal_metadata", []), [{ checkpoints: 7, receipts_backfilled: 1 }])
    assert.deepEqual(execute("SELECT * FROM runtime_wakes", []), [{ id: fixture.recovery.wake.id, entry: JSON.stringify(fixture.recovery.wake) }])
    assert.deepEqual(execute("SELECT * FROM runtime_watchdogs", []), [{ id: fixture.recovery.key, entry: JSON.stringify(fixture.recovery.watchdog) }])
    assert.deepEqual(execute("SELECT * FROM runtime_generation", []), [{ id: 1, value: fixture.recovery.generation }])
    assert.equal(execute("SELECT name FROM sqlite_master WHERE name GLOB 'stored_*'", []).length, 0)
    await Effect.runPromise(journal.close)
    journal = open()
    assert.deepEqual(await Effect.runPromise(journal.readInputs), [input])
    await Effect.runPromise(journal.appendWithCheckpoint(1, [], { position: 1, payload, digest }, { remove: [ref] }))
    assert.deepEqual(await Effect.runPromise(journal.readInputs), [])
    assert.equal(execute("SELECT checkpoints FROM journal_metadata", [])[0]!.checkpoints, 8)
  } finally { await Effect.runPromise(journal.close) }
}
