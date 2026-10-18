import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { checkpointDigest, encodeCheckpoint, effectKey, type EffectRef } from "@clavia/tardigrade-core"
import { prepareDocumentInput } from "@clavia/tardigrade-core/services/tree-state"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

const driverFor = (db: Database): SyncSqlite => ({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() })
const text = "\u{1F332}é漢字".repeat(2048)
const ref: EffectRef = { act: "job", atom: "root", seq: 1 }
const checkpoint = async (position: number, note = text, root?: string) => {
  const payload = encodeCheckpoint({ position, durable: [{ name: "inline", state: { note }, position }, ...(root ? [{ name: "document", state: { _tag: "DocumentState", reference: root }, reference: root, position }] : [])], operations: [] })
  return { position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
}
const count = (db: Database, table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n

test("large UTF-8 events, accepted inputs and checkpoints reopen and remove obsolete chunks", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let journal = synchronousJournal<{ type: string; text?: string }>({ actor: "chunks", driver, checkpointChunkBytes: 511, eventInlineBytes: 256, limits: { maxRowBytes: 4096 } })
  try {
    const saved = await checkpoint(1)
    const request = { act: ref.act, input: { text } }
    await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Large", text } }], saved, { put: [{ ref, request }] }))
    for (const table of ["stored_journal_event_chunks", "stored_journal_input_chunks", "stored_journal_checkpoint_chunks"]) {
      expect(count(db, table)).toBeGreaterThan(1)
      expect(db.query<{ n: number }, []>(`SELECT MAX(length(payload)) n FROM ${table}`).get()!.n).toBeLessThanOrEqual(511)
    }
    expect(JSON.parse(db.query<{ record: string }, []>("SELECT record FROM stored_journal_events").get()!.record)).toEqual({ event: { type: "Large" } })
    await Effect.runPromise(journal.close)
    journal = synchronousJournal({ actor: "chunks", driver, checkpointChunkBytes: 511, eventInlineBytes: 256, limits: { maxRowBytes: 4096 } })
    expect(await Effect.runPromise(journal.read)).toEqual([{ event: { type: "Large", text } }])
    expect(await Effect.runPromise(journal.readInputs)).toEqual([{ ref, request }])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(saved.payload)
    const before = count(db, "stored_journal_input_chunks")
    await Effect.runPromise(journal.append(1, [], { put: [{ ref, request }] }))
    expect(count(db, "stored_journal_input_chunks")).toBe(before)
    await expect(Effect.runPromise(journal.append(1, [{ event: { type: "Invalid" } }], { put: [{ ref, request: { ...request, input: { text: "changed" } } }] }))).rejects.toThrow("cannot change")
    const small = await checkpoint(2, "small")
    await Effect.runPromise(journal.appendWithCheckpoint(1, [{ event: { type: "Completed" } }], small, { remove: [ref] }))
    expect(count(db, "stored_journal_input_chunks")).toBe(0)
    expect(count(db, "stored_journal_checkpoint_chunks")).toBe(1)
    expect(await Effect.runPromise(journal.readAfter(1))).toEqual([{ event: { type: "Completed" } }])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(small.payload)
    expect(journal.chunking).toMatchObject({ checkpointChunkBytes: 511, eventInlineBytes: 256, maxRowBytes: 4096 })
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("partial event and replacement checkpoint writes roll back chunks and Grove owners", async () => {
  const db = new Database(":memory:"), native = driverFor(db)
  let failTable: string | undefined = "stored_journal_event_chunks"
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (failTable && sql.startsWith(`INSERT INTO ${failTable}`) && Number(parameters[failTable === "stored_journal_checkpoint_chunks" ? 1 : 2]) === 1) throw new Error("Injected partial chunk failure")
    return native.execute(sql, parameters)
  } }
  const journal = synchronousJournal<{ type: string; text?: string }>({ actor: "rollback", driver, checkpointChunkBytes: 127, eventInlineBytes: 128 })
  try {
    const State = Schema.Struct({ value: Schema.String })
    const a = journal.storedValues.bind(State).initial({ value: "A" })
    const request = { act: ref.act, ...prepareDocumentInput({ state: a.select([]), text }) }
    const first = await checkpoint(1, text, encodeReference(a.reference!))
    const changes = { documents: { references: [{ name: "document", reference: encodeReference(a.reference!) }] }, put: [{ ref, request }] }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Accepted", text } }], first, changes))).rejects.toThrow("Injected")
    for (const table of ["stored_journal_events", "stored_journal_event_chunks", "stored_journal_inputs", "stored_journal_input_chunks", "stored_journal_checkpoints", "stored_journal_checkpoint_chunks"]) expect(count(db, table)).toBe(0)
    expect(journal.grove.owners("")).toEqual([])
    expect(journal.grove.stats().stagedNodes).toBeGreaterThan(0)
    failTable = undefined
    await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Accepted", text } }], first, changes))
    const b = a.set(["value"], "B"), next = await checkpoint(2, text + "next", encodeReference(b.reference!))
    failTable = "stored_journal_checkpoint_chunks"
    const completion = { documents: { references: [{ name: "document", reference: encodeReference(b.reference!) }] }, remove: [ref] }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(1, [{ event: { type: "Completed" } }], next, completion))).rejects.toThrow("Injected")
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(first.payload)
    expect(await Effect.runPromise(journal.readInputs)).toEqual([{ ref, request }])
    expect((await Effect.runPromise(journal.read)).length).toBe(1)
    expect(journal.grove.view(decodeReference(encodeReference(a.reference!)), State).materialize()).toEqual({ value: "A" })
    failTable = undefined
    await Effect.runPromise(journal.appendWithCheckpoint(1, [{ event: { type: "Completed" } }], next, completion))
    await Effect.runPromise(journal.collect)
    expect(await Effect.runPromise(journal.readInputs)).toEqual([])
    expect(() => journal.grove.view(decodeReference(encodeReference(a.reference!)), State).materialize()).toThrow()
    expect(journal.grove.stats()).toMatchObject({ stagedNodes: 0, activeLeases: 0 })
  } finally { await Effect.runPromise(journal.close); db.close() }
})

for (const kind of ["event", "input", "checkpoint"] as const) test(`${kind} chunks reject missing, reordered, resized and corrupt payloads`, async () => {
  for (const corruption of ["missing", "ordinal", "length", "digest", "count"] as const) {
    const db = new Database(":memory:"), journal = synchronousJournal<{ type: string; text: string }>({ actor: "corrupt", driver: driverFor(db), checkpointChunkBytes: 127, eventInlineBytes: 128 })
    try {
      await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Large", text } }], await checkpoint(1), { put: [{ ref, request: { act: ref.act, input: { text } } }] }))
      const table = `stored_journal_${kind}_chunks`, header = kind === "event" ? "stored_journal_events" : kind === "input" ? "stored_journal_inputs" : "stored_journal_checkpoints"
      if (corruption === "missing") db.exec(`DELETE FROM ${table} WHERE ordinal=0`)
      if (corruption === "ordinal") db.exec(`UPDATE ${table} SET ordinal=9999 WHERE ordinal=0`)
      if (corruption === "length") db.exec(`UPDATE ${header} SET byte_length=byte_length+1`)
      if (corruption === "count") db.exec(`UPDATE ${header} SET chunk_count=chunk_count+1`)
      if (corruption === "digest") {
        const bytes = db.query<{ payload: Uint8Array }, []>(`SELECT payload FROM ${table} WHERE ordinal=0`).get()!.payload.slice()
        bytes[0] = bytes[0]! ^ 1
        db.query(`UPDATE ${table} SET payload=? WHERE ordinal=0`).run(bytes)
      }
      const read: Effect.Effect<unknown, Error> = kind === "event" ? journal.read : kind === "input" ? journal.readInputs : journal.readCheckpoint
      await expect(Effect.runPromise(read)).rejects.toThrow()
    } finally { await Effect.runPromise(journal.close); db.close() }
  }
})

test("row budgets account for Unicode actor and effect identities and expose actual policies", async () => {
  const db = new Database(":memory:"), native = driverFor(db), maxRowBytes = 512
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (sql.startsWith("INSERT INTO stored_journal_")) {
      const bytes = parameters.reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0), 32)
      if (bytes > maxRowBytes) throw new Error(`Row exceeded budget: ${bytes}`)
    }
    return native.execute(sql, parameters)
  } }
  const journal = synchronousJournal<{ type: string; text: string }>({ actor: "actor-\u{1F332}", driver, limits: { maxRowBytes } })
  try {
    await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Large", text } }], await checkpoint(1), { put: [{ ref, request: { act: ref.act, input: { text } } }] }))
    expect((await Effect.runPromise(journal.read))[0]!.event).toEqual({ type: "Large", text })
    expect(journal.chunking.checkpointChunkBytes).toBeLessThan(maxRowBytes)
    expect(journal.chunking.inputChunkBytes(effectKey(ref))).toBeLessThan(journal.chunking.checkpointChunkBytes)
    expect(() => synchronousJournal({ actor: "bad", driver, limits: { maxRowBytes }, checkpointChunkBytes: maxRowBytes })).toThrow("capacity")
    expect(() => synchronousJournal({ actor: "bad", driver, limits: { maxRowBytes }, eventInlineBytes: maxRowBytes })).toThrow("eventInlineBytes")
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("existing inline rows remain readable while new writes use chunked envelopes", async () => {
  const db = new Database(":memory:"), driver = driverFor(db), saved = await checkpoint(1, "legacy")
  db.exec("CREATE TABLE stored_journal_events(actor TEXT,seq INTEGER,record TEXT,PRIMARY KEY(actor,seq))")
  db.exec("CREATE TABLE stored_journal_inputs(actor TEXT,ref TEXT,input TEXT,PRIMARY KEY(actor,ref))")
  db.exec("CREATE TABLE stored_journal_checkpoints(actor TEXT PRIMARY KEY,position INTEGER,payload BLOB,digest TEXT)")
  const input = { ref, request: { act: ref.act, input: { text: "legacy" } } }
  db.query("INSERT INTO stored_journal_events VALUES(?,?,?)").run("upgrade", 0, JSON.stringify({ event: { type: "Legacy" } }))
  db.query("INSERT INTO stored_journal_inputs VALUES(?,?,?)").run("upgrade", effectKey(ref), JSON.stringify(input))
  db.query("INSERT INTO stored_journal_checkpoints VALUES(?,?,?,?)").run("upgrade", 1, saved.payload, saved.digest)
  const journal = synchronousJournal<{ type: string; text?: string }>({ actor: "upgrade", driver, checkpointChunkBytes: 127, eventInlineBytes: 128 })
  try {
    expect(await Effect.runPromise(journal.read)).toEqual([{ event: { type: "Legacy" } }])
    expect(await Effect.runPromise(journal.readInputs)).toEqual([input])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(saved.payload)
    await Effect.runPromise(journal.append(1, [{ event: { type: "Large", text } }], { put: [input] }))
    expect(count(db, "stored_journal_input_chunks")).toBe(0)
    expect((await Effect.runPromise(journal.readAfter(1)))[0]!.event).toEqual({ type: "Large", text })
    expect(count(db, "stored_journal_event_chunks")).toBeGreaterThan(1)
  } finally { await Effect.runPromise(journal.close); db.close() }
})
