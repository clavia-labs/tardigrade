import fc from "fast-check"
import fixture from "../fixtures/migration/050-snapshot.json"
import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { legacyStore, type SyncSqlite } from "@tardie/grove/sqlite"
import { decodeCheckpoint, effectKey, type Recorded } from "@clavia/tardigrade-core"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { encodeCheckpointChunks } from "../../src/shared/checkpoint-chunks"
import { storedPayloadDigest } from "../../src/shared/stored-journal-payloads"
import { appendOnly, tree, keyValue, encodeReference, decodeReference } from "@tardie/grove"

type SqlValue = string | number | null | { readonly base64: string }
interface Table { readonly name: string; readonly sql: string; readonly rows: readonly Readonly<Record<string, SqlValue>>[] }
const tables = fixture.tables as readonly Table[]
const same = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error("Journal migration changed retained state") }
export const migrationCases = fc.record({ actor: fc.constantFrom("events", "界", "a%_", "__proto__"), layout: fc.constantFrom("tree", "bytes-v3", "bytes-v2"), shared: fc.boolean(), chunkBytes: fc.constantFrom(1, 7, 127), rollback: fc.boolean(), cleanup: fc.boolean() })
type Case = typeof migrationCases extends fc.Arbitrary<infer Value> ? Value : never
const historyRoot = tables.find(table => table.name === "grove_owners")!.rows.find(row => String(row.name).startsWith('["events","state",'))!.root as string

// journalMigrationProperty covers frozen 0.50 layouts, rollback, shared roots and repeated opens (bun/migration.test.ts; workerd/migration.workers.ts).
export async function journalMigrationProperty(driver: SyncSqlite, scenario: Case, corrupt?: "input-digest" | "input-chunk" | "tree-node") {
  const { actor, layout, shared, chunkBytes, rollback, cleanup } = scenario
  const query = driver.execute
  const scope = JSON.stringify(["tardigrade", actor])
  driver.transaction(() => {
    for (const table of tables) query(table.sql, [])
    for (const index of fixture.indexes) query(index.sql, [])
    for (const table of [...tables].sort((a, b) => Number(b.name === "experimental_events") - Number(a.name === "experimental_events"))) for (const source of table.rows) {
      const row = { ...source }
      if (row.actor === "events") row.actor = actor
      if (table.name === "grove_owners") row.name = String(row.name).replace('["events",', JSON.stringify([actor]).slice(0, -1) + ",")
      const values = Object.values(row).map(value => typeof value === "object" && value !== null ? Uint8Array.from(atob(value.base64), char => char.charCodeAt(0)) : value)
      query(`INSERT INTO ${table.name} (${Object.keys(row).join(",")}) VALUES (${values.map(() => "?").join(",")})`, values)
    }
    const checkpointOwner = JSON.stringify([actor, "checkpoint"])
    const root = String(query("SELECT root FROM grove_owners WHERE name=?", [checkpointOwner])[0]!.root)
    const rawCheckpoint = legacyStore(driver, scope).read(root)
    if (!rawCheckpoint || typeof rawCheckpoint !== "object" || Array.isArray(rawCheckpoint)) throw new Error("Invalid fixture checkpoint")
    const checkpoint = rawCheckpoint as Readonly<Record<string, unknown>>
    const request = { ...fixture.records[2]!.event, request: { ...fixture.inputs[0]!.request, input: { _tag: "InlineInput", value: fixture.inputs[0]!.request.input } } }
    const settlement = { type: "EffectSettled", ref: fixture.ref, outcome: { status: "fulfilled", value: { type: "value", value: 1 } } }
    const cancellation = { type: "EffectCancelled", ref: fixture.ref, reason: "stop" }
    const position = cleanup ? 5 : Number(checkpoint.position)
    const durable = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(checkpoint.durable).map(entry => {
      if (!entry || typeof entry !== "object" || !("name" in entry)) throw new Error("Invalid fixture durable entry")
      return { ...entry, position, ...(cleanup && entry.name === "migration.control" ? { state: { started: true, done: false } } : {}) }
    })
    const operations = cleanup ? [{ ref: fixture.ref, request, execution: { outcome: settlement }, cleanup: { request: cancellation } }] : []
    const current = { ...checkpoint, position, durable, operations }
    if (cleanup) {
      for (const [offset, event] of [settlement, cancellation].entries()) {
        const payload = new TextEncoder().encode(JSON.stringify({ event })), chunks = encodeCheckpointChunks(payload, 127)
        query("INSERT INTO experimental_events VALUES(?,?,?)", [actor, 3 + offset, JSON.stringify({ event: { type: event.type }, chunkCount: chunks.length, byteLength: payload.byteLength })])
        for (const chunk of chunks) query("INSERT INTO experimental_event_chunks VALUES(?,?,?,?)", [actor, 3 + offset, chunk.ordinal, chunk.payload])
      }
    }
    if (layout !== "tree") {
      const value = layout === "bytes-v2" ? { version: 2, position, durable, effects: operations.map(operation => ({ ref: operation.ref, request: operation.request, settlement, cancellation })), promises: [] } : current
      const payload = new TextEncoder().encode(JSON.stringify(value)), chunks = encodeCheckpointChunks(payload, 127)
      query("INSERT INTO checkpoint VALUES(1,?,?,?,?)", [position, payload.byteLength, chunks.length, storedPayloadDigest(payload)])
      for (const chunk of chunks) query("INSERT INTO checkpoint_chunks VALUES(?,?)", [chunk.ordinal, chunk.payload])
      query("DELETE FROM checkpoint_trees WHERE actor=?", [actor])
      query("DELETE FROM grove_owners WHERE name=?", [checkpointOwner])
    } else if (cleanup) {
      const payload = new TextEncoder().encode(JSON.stringify([3, "v", current])), hash = storedPayloadDigest(payload), chunks = encodeCheckpointChunks(payload, 127)
      query("INSERT INTO grove_nodes VALUES(?,?,?,?,?)", [hash, payload.byteLength, chunks.length, new Uint8Array(), null])
      for (const chunk of chunks) query("INSERT INTO grove_chunks VALUES(?,?,?)", [hash, chunk.ordinal, chunk.payload])
      query("UPDATE grove_owners SET root=? WHERE name=?", [hash, checkpointOwner])
      query("UPDATE checkpoint_trees SET position=? WHERE actor=?", [position, actor])
    }
    if (shared) query("INSERT INTO grove_owners VALUES(?,?)", [JSON.stringify(["other-actor", "state", "history"]), historyRoot])
    if (corrupt === "input-digest") query("UPDATE effect_inputs SET digest=? WHERE actor=?", ["0".repeat(64), actor])
    if (corrupt === "input-chunk") query("DELETE FROM effect_input_chunks WHERE actor=? AND ordinal=0", [actor])
    if (corrupt === "tree-node") query("DELETE FROM grove_nodes WHERE hash=?", [historyRoot])
  })
  const snapshot = () => tables.map(table => ({ name: table.name, rows: query(`SELECT * FROM ${table.name}`, []).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer || value instanceof Uint8Array ? Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)) : value]))) }))
  const original = snapshot()
  const open = () => synchronousJournal({ driver, actor, checkpointChunkBytes: chunkBytes, cacheBytes: 0 })
  if (corrupt) {
    let rejected = false
    try { const journal = open(); await Effect.runPromise(journal.close) } catch { rejected = true }
    if (!rejected) throw new Error("Corrupt migration was accepted")
    same(snapshot(), original)
    same(query("SELECT * FROM grove_value_owners", []), [])
    return
  }
  if (rollback) {
    query(`CREATE TRIGGER migration_fault BEFORE DELETE ON ${layout === "tree" ? "checkpoint_trees" : "checkpoint"} BEGIN SELECT RAISE(ABORT,'migration property fault'); END`, [])
    let rejected = false
    try { open() } catch (cause) { if (!String(cause).includes("migration property fault")) throw cause; rejected = true }
    if (!rejected) throw new Error("Migration did not reach the injected cleanup fault")
    same(snapshot(), original)
    same(query("SELECT * FROM grove_value_owners", []), [])
    query("DROP TRIGGER migration_fault", [])
  }
  let journal = open()
  try {
    const checkpoint = await Effect.runPromise(journal.readCheckpoint)
    if (!checkpoint) throw new Error("Migration dropped the checkpoint")
    const decoded = decodeCheckpoint(checkpoint.payload)
    same(decoded.position, cleanup ? 5 : 1)
    same(decoded.durable.find(entry => entry.name === "migration.history")!.state, fixture.input)
    const inputs = await Effect.runPromise(journal.readInputs)
    same(inputs.length, 1)
    same(inputs[0]!.ref, fixture.ref)
    same(effectKey(inputs[0]!.ref), fixture.effectKey)
    same(journal.storedValues.resolve(inputs[0]!.request), fixture.acceptedInput)
    const records = await Effect.runPromise(journal.read)
    const accepted = records.find(record => (record.event as { type?: string }).type === "EffectRequested")!.event as { request: { selections: unknown } }
    same(accepted.request.selections, inputs[0]!.request.selections)
    same(decoded.operations.length, cleanup ? 1 : 0)
    if (cleanup) same(decoded.operations[0]!.request.request.selections, inputs[0]!.request.selections)
    for (const table of ["experimental_events", "experimental_event_chunks", "experimental_messages"]) same(snapshot().find(entry => entry.name === table), original.find(entry => entry.name === table))
    same(query("SELECT * FROM checkpoint", []), [])
    same(query("SELECT * FROM effect_inputs WHERE actor=?", [actor]), [])
    if (shared) same(legacyStore(driver, scope).read(historyRoot), fixture.input)
    else same(query("SELECT * FROM grove_nodes", []), [])
    await Effect.runPromise(journal.collect)
    same(journal.storedValues.resolve(inputs[0]!.request), fixture.acceptedInput)
    await Effect.runPromise(journal.close)
    journal = open()
    same(await Effect.runPromise(journal.readInputs), inputs)
    same(await Effect.runPromise(journal.readCheckpoint), checkpoint)
    same(await Effect.runPromise(journal.read), records)
  } finally { await Effect.runPromise(journal.close) }
}

export const eventLogCases = fc.record({ actor: fc.constantFrom("events", "界", "__proto__"), texts: fc.array(fc.string(), { minLength: 2, maxLength: 6 }), chunkBytes: fc.constantFrom(1, 7, 127), inlineBytes: fc.constantFrom(64, 256) })
type EventLogCase = typeof eventLogCases extends fc.Arbitrary<infer Value> ? Value : never
type CompatEvent = { readonly type: "MessageReceived"; readonly body: { readonly text: string } }
const sameEventLog = (a: unknown, b: unknown) => { if (!isDeepStrictEqual(a, b)) throw new Error("0.50 event log compatibility changed") }

// encode050 freezes the writer contract from d0191382: packages/platform/src/shared/sql-journal.ts.
const encode050 = (record: Recorded<CompatEvent>, inlineBytes: number, chunkBytes: number) => {
  const text = JSON.stringify(record), payload = new TextEncoder().encode(text), chunks: Uint8Array[] = []
  if (payload.byteLength > inlineBytes) for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) chunks.push(payload.slice(offset, offset + chunkBytes))
  return { event: chunks.length ? JSON.stringify({ event: { type: record.event.type }, chunkCount: chunks.length, byteLength: payload.byteLength }) : text, chunks }
}

// eventLogCompatibility preserves 0.50 table schemas, row bytes and receipts while publishing Grove state (bun/migration.test.ts; workerd/migration.workers.ts).
export async function eventLogCompatibility(driver: SyncSqlite, options: EventLogCase) {
  const { actor, chunkBytes, inlineBytes } = options
  const query = driver.execute
  for (const sql of [
    "CREATE TABLE experimental_events (actor TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor, seq)) WITHOUT ROWID",
    "CREATE INDEX experimental_thread_versions ON experimental_events (actor, seq DESC) WHERE json_extract(event, '$.event.type') IN ('ThreadCreated', 'ThreadUpdated')",
    "CREATE TABLE experimental_event_chunks (actor TEXT NOT NULL, seq INTEGER NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (actor, seq, ordinal), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID",
    "CREATE TABLE experimental_messages (actor TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor, id), FOREIGN KEY (actor, seq) REFERENCES experimental_events(actor, seq)) WITHOUT ROWID",
  ]) query(sql, [])
  const records: Recorded<CompatEvent>[] = options.texts.map((text, index) => ({ event: { type: "MessageReceived", body: { text: index % 2 ? text + "界🙂".repeat(32) : text } }, recordedAt: index, message: { id: `old:${index}`, from: { kind: "external", id: "source" } } }))
  driver.transaction(() => {
    for (const [seq, record] of records.entries()) {
      const stored = encode050(record, seq % 2 ? 1 : Number.MAX_SAFE_INTEGER, chunkBytes)
      query("INSERT INTO experimental_events VALUES(?,?,?)", [actor, seq, stored.event])
      stored.chunks.forEach((payload, ordinal) => query("INSERT INTO experimental_event_chunks VALUES(?,?,?,?)", [actor, seq, ordinal, payload]))
      query("INSERT INTO experimental_messages VALUES(?,?,?)", [actor, record.message!.id, seq])
    }
  })
  const bytes = (value: unknown) => { if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error("CompatEvent chunk is not bytes"); return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)) }
  const snapshot = () => ({
    schema: query("SELECT name,sql FROM sqlite_master WHERE name IN ('experimental_events','experimental_event_chunks','experimental_messages','experimental_thread_versions') ORDER BY name", []),
    events: query("SELECT seq,event FROM experimental_events WHERE actor=? AND seq<? ORDER BY seq", [actor, records.length]),
    chunks: query("SELECT seq,ordinal,payload FROM experimental_event_chunks WHERE actor=? AND seq<? ORDER BY seq,ordinal", [actor, records.length]).map(row => ({ ...row, payload: bytes(row.payload) })),
    messages: query("SELECT id,seq FROM experimental_messages WHERE actor=? AND seq<? ORDER BY seq", [actor, records.length]),
  })
  const original = snapshot()
  let fail = false
  const native: SyncSqlite = { ...driver, execute: (sql, parameters) => { if (fail && sql.startsWith("INSERT INTO experimental_messages")) throw new Error("Injected receipt failure"); return query(sql, parameters) } }
  const open = () => synchronousJournal<CompatEvent>({ actor, driver: native, eventInlineBytes: inlineBytes, checkpointChunkBytes: chunkBytes })
  let journal = open()
  const State = Schema.Struct({ current: tree(Schema.Int), history: appendOnly(Schema.Array(Schema.String)), jobs: keyValue(Schema.Int) })
  const document = journal.storedValues.bind(State).initial({ current: records.length + 1, history: ["new"], jobs: { new: 1 } })
  const reference = encodeReference(document.reference)
  const added: Recorded<CompatEvent> = { event: { type: "MessageReceived", body: { text: "new:" + "界🙂".repeat(100) } }, message: { id: "new", from: { kind: "external", id: "source" } }, recordedAt: records.length }
  const changes = { documents: { references: [{ name: "document", reference }] } }
  try {
    sameEventLog(snapshot(), original)
    sameEventLog(await Effect.runPromise(journal.read), records)
    sameEventLog(await Effect.runPromise(journal.readFirst), records[0])
    for (const [index, record] of records.entries()) sameEventLog(await Effect.runPromise(journal.readMessage(record.message!.id)), { position: index + 1, record })
    fail = true
    try { await Effect.runPromise(journal.append(records.length, [added], changes)); throw new Error("Missing receipt failure") } catch (cause) { if (!String(cause).includes("Injected receipt failure")) throw cause }
    sameEventLog(snapshot(), original)
    sameEventLog(await Effect.runPromise(journal.read), records)
    sameEventLog(journal.grove.owners("").length, 0)
    fail = false
    await Effect.runPromise(journal.append(records.length, [added], changes))
    sameEventLog(snapshot(), original)
    const expected = encode050(added, inlineBytes, chunkBytes)
    sameEventLog(query("SELECT event FROM experimental_events WHERE actor=? AND seq=?", [actor, records.length])[0]?.event, expected.event)
    sameEventLog(query("SELECT payload FROM experimental_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal", [actor, records.length]).map(row => bytes(row.payload)), expected.chunks.map(value => Array.from(value)))
    sameEventLog(query("PRAGMA table_info(experimental_events)", []).map(row => row.name), ["actor", "seq", "event"])
    sameEventLog(query("SELECT name FROM sqlite_master WHERE name='stored_journal_events'", []), [])
    await Effect.runPromise(journal.close); journal = open()
    sameEventLog(await Effect.runPromise(journal.readAfter(records.length)), [added])
    sameEventLog(await Effect.runPromise(journal.readMessage("new")), { position: records.length + 1, record: added })
    sameEventLog(journal.grove.view(decodeReference(reference), State).materialize(), { current: records.length + 1, history: ["new"], jobs: { new: 1 } })
    sameEventLog(snapshot(), original)
  } finally { await Effect.runPromise(journal.close) }
}
