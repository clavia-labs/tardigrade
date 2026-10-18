import fc from "fast-check"
import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Recorded } from "@clavia/tardigrade-core"
import { appendOnly, tree, keyValue, encodeReference, decodeReference } from "@tardie/grove"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

export const eventLogCases = fc.record({ actor: fc.constantFrom("events", "界", "__proto__"), texts: fc.array(fc.string(), { minLength: 2, maxLength: 6 }), chunkBytes: fc.constantFrom(1, 7, 127), inlineBytes: fc.constantFrom(64, 256) })
type Case = typeof eventLogCases extends fc.Arbitrary<infer Value> ? Value : never
type Event = { readonly type: "MessageReceived"; readonly body: { readonly text: string } }
const same = (a: unknown, b: unknown) => { if (!isDeepStrictEqual(a, b)) throw new Error("0.50 event log compatibility changed") }

// encode050 freezes the writer contract from d0191382: packages/platform/src/shared/sql-journal.ts.
const encode050 = (record: Recorded<Event>, inlineBytes: number, chunkBytes: number) => {
  const text = JSON.stringify(record), payload = new TextEncoder().encode(text), chunks: Uint8Array[] = []
  if (payload.byteLength > inlineBytes) for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) chunks.push(payload.slice(offset, offset + chunkBytes))
  return { event: chunks.length ? JSON.stringify({ event: { type: record.event.type }, chunkCount: chunks.length, byteLength: payload.byteLength }) : text, chunks }
}

// eventLogCompatibility preserves 0.50 table schemas, row bytes and receipts while publishing Grove state (bun/event-log-compatibility.test.ts; workerd/event-log-compatibility.workers.ts).
export async function eventLogCompatibility(driver: SyncSqlite, options: Case) {
  const { actor, chunkBytes, inlineBytes } = options
  const query = driver.execute
  for (const sql of [
    "CREATE TABLE experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID",
    "CREATE INDEX experimental_thread_versions ON experimental_events (actor, seq DESC) WHERE json_extract(event, '$.event.type') IN ('ThreadCreated', 'ThreadUpdated')",
    "CREATE TABLE experimental_event_chunks (actor TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (actor, seq, ordinal), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID",
    "CREATE TABLE experimental_messages (actor TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, id), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID",
  ]) query(sql, [])
  const records: Recorded<Event>[] = options.texts.map((text, index) => ({ event: { type: "MessageReceived", body: { text: index % 2 ? text + "界🙂".repeat(32) : text } }, recordedAt: index, message: { id: `old:${index}`, from: { kind: "external", id: "source" } } }))
  driver.transaction(() => {
    for (const [seq, record] of records.entries()) {
      const stored = encode050(record, seq % 2 ? 1 : Number.MAX_SAFE_INTEGER, chunkBytes)
      query("INSERT INTO experimental_events VALUES(?,?,?)", [actor, seq, stored.event])
      stored.chunks.forEach((payload, ordinal) => query("INSERT INTO experimental_event_chunks VALUES(?,?,?,?)", [actor, seq, ordinal, payload]))
      query("INSERT INTO experimental_messages VALUES(?,?,?)", [actor, record.message!.id, seq])
    }
  })
  const bytes = (value: unknown) => { if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error("Event chunk is not bytes"); return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)) }
  const snapshot = () => ({
    schema: query("SELECT name,sql FROM sqlite_master WHERE name IN ('experimental_events','experimental_event_chunks','experimental_messages','experimental_thread_versions') ORDER BY name", []),
    events: query("SELECT seq,event FROM experimental_events WHERE actor=? AND seq<? ORDER BY seq", [actor, records.length]),
    chunks: query("SELECT seq,ordinal,payload FROM experimental_event_chunks WHERE actor=? AND seq<? ORDER BY seq,ordinal", [actor, records.length]).map(row => ({ ...row, payload: bytes(row.payload) })),
    messages: query("SELECT id,seq FROM experimental_messages WHERE actor=? AND seq<? ORDER BY seq", [actor, records.length]),
  })
  const original = snapshot()
  let fail = false
  const native: SyncSqlite = { ...driver, execute: (sql, parameters) => { if (fail && sql.startsWith("INSERT INTO experimental_messages")) throw new Error("Injected receipt failure"); return query(sql, parameters) } }
  const open = () => synchronousJournal<Event>({ actor, driver: native, eventInlineBytes: inlineBytes, checkpointChunkBytes: chunkBytes })
  let journal = open()
  const State = Schema.Struct({ current: tree(Schema.Int), history: appendOnly(Schema.Array(Schema.String)), jobs: keyValue(Schema.Int) })
  const document = journal.storedValues.bind(State).initial({ current: records.length + 1, history: ["new"], jobs: { new: 1 } })
  const reference = encodeReference(document.reference)
  const added: Recorded<Event> = { event: { type: "MessageReceived", body: { text: "new:" + "界🙂".repeat(100) } }, message: { id: "new", from: { kind: "external", id: "source" } }, recordedAt: records.length }
  const changes = { documents: { references: [{ name: "document", reference }] } }
  try {
    same(snapshot(), original)
    same(await Effect.runPromise(journal.read), records)
    same(await Effect.runPromise(journal.readFirst), records[0])
    for (const [index, record] of records.entries()) same(await Effect.runPromise(journal.readMessage(record.message!.id)), { position: index + 1, record })
    fail = true
    try { await Effect.runPromise(journal.append(records.length, [added], changes)); throw new Error("Missing receipt failure") } catch (cause) { if (!String(cause).includes("Injected receipt failure")) throw cause }
    same(snapshot(), original)
    same(await Effect.runPromise(journal.read), records)
    same(journal.grove.owners("").length, 0)
    fail = false
    await Effect.runPromise(journal.append(records.length, [added], changes))
    same(snapshot(), original)
    const expected = encode050(added, inlineBytes, chunkBytes)
    same(query("SELECT event FROM experimental_events WHERE actor=? AND seq=?", [actor, records.length])[0]?.event, expected.event)
    same(query("SELECT payload FROM experimental_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal", [actor, records.length]).map(row => bytes(row.payload)), expected.chunks.map(value => Array.from(value)))
    same(query("PRAGMA table_info(experimental_events)", []).map(row => row.name), ["actor", "seq", "event"])
    same(query("SELECT name FROM sqlite_master WHERE name='stored_journal_events'", []), [])
    await Effect.runPromise(journal.close); journal = open()
    same(await Effect.runPromise(journal.readAfter(records.length)), [added])
    same(await Effect.runPromise(journal.readMessage("new")), { position: records.length + 1, record: added })
    same(journal.grove.view(decodeReference(reference), State).materialize(), { current: records.length + 1, history: ["new"], jobs: { new: 1 } })
    same(snapshot(), original)
  } finally { await Effect.runPromise(journal.close) }
}
