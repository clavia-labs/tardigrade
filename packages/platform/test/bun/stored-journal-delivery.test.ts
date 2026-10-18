import { encodeReference } from "@tardie/grove"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, createActorStore, defineActor, durableAtom, tree, effectAtom, event, checkpointDigest, encodeCheckpoint, MessageConflict, type Recorded } from "@clavia/tardigrade-core"
import { initializeThread, updateThreadVersion } from "@clavia/tardigrade-core/services/journal/thread"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

const driverFor = (db: Database): SyncSqlite => ({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() })
const message = { id: "one", from: { kind: "external" as const, id: "sender" } }
const record = (id = message.id, text = "é漢字".repeat(1024)) => ({ event: { type: "MessageReceived" as const, body: { type: "Added", text } }, message: { ...message, id } })
const address = { actor: "counter", instance: "main", thread: "one" }
const creation = { type: "ThreadCreated" as const, address, parent: null, depth: 0, placement: "independent" as const, version: "v1" }
const saved = async (position: number) => {
  const payload = encodeCheckpoint({ position, durable: [], operations: [] })
  return { position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
}

test("actor message receipts deduplicate across checkpoint and restart and reject changed input or sender", async () => {
  const Added = event({ type: "Added", amount: Schema.Int })
  const count = durableAtom({ name: "delivery.count", input: Added, schema: tree(Schema.Struct({ count: Schema.Int })), initial: { count: 0 }, reduce: (state, event) => state.set(["count"], state.read(["count"]) + event.amount) })
  const actor = defineActor("counter", Effect.succeed({ schema: Added,
    atom: effectAtom(get => ({ view: get(count).read(["count"]), events: {}, acts: {} })),
    methods: { add: actorMethod({ inputSchema: Schema.Int, outputSchema: Schema.Int, onReceive: Added.from(amount => ({ amount })), result: (_, get) => ({ status: "completed", output: get(count).read(["count"]) }) }) },
  }))
  const db = new Database(":memory:"), driver = driverFor(db)
  let flushes = 0
  const open = () => synchronousJournal<typeof Added.Type>({ actor: "actor", driver, eventInlineBytes: 64, flush: Effect.sync(() => { flushes++ }) })
  let journal = open()
  const boot = () => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: Context.pick(), services: () => Layer.empty }))
  let store = await boot()
  try {
    const request = { method: "add", input: 3 }
    const first = await Effect.runPromise(store.receive(request, message))
    const before = flushes
    expect(await Effect.runPromise(store.receive(request, message))).toEqual(first)
    expect(flushes).toBe(before + 1)
    expect(store.get(count).read(["count"])).toBe(3)
    await expect(Effect.runPromise(store.receive({ method: "add", input: 4 }, message))).rejects.toBeInstanceOf(MessageConflict)
    await expect(Effect.runPromise(store.receive(request, { ...message, from: { kind: "external", id: "other" } }))).rejects.toBeInstanceOf(MessageConflict)
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = open()
    store = await boot()
    expect(await Effect.runPromise(store.receive(request, message))).toEqual(first)
    expect(store.get(count).read(["count"])).toBe(3)
    expect((await Effect.runPromise(journal.read)).filter(item => item.message?.id === message.id).length).toBe(1)
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close); db.close() }
})

test("receipt index failures and duplicate identities roll back chunks, checkpoints and Grove publication", async () => {
  const db = new Database(":memory:"), native = driverFor(db)
  let fail = true
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (fail && sql.startsWith("INSERT INTO experimental_messages")) throw new Error("Injected message index failure")
    return native.execute(sql, parameters)
  } }
  const journal = synchronousJournal({ actor: "atomic", driver, eventInlineBytes: 64, checkpointChunkBytes: 128 })
  try {
    const document = journal.storedValues.bind(Schema.Struct({ text: Schema.String })).initial({ text: "A" })
    const changes = { documents: { references: [{ name: "state", reference: encodeReference(document.reference!) }] } }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [record()], await saved(1), changes))).rejects.toThrow("index failure")
    expect(await Effect.runPromise(journal.readMessage(message.id))).toBeUndefined()
    expect(await Effect.runPromise(journal.readFirst)).toBeUndefined()
    expect(await Effect.runPromise(journal.readCheckpoint)).toBeUndefined()
    expect(journal.grove.owners("")).toEqual([])
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM experimental_event_chunks").get()!.n).toBe(0)
    fail = false
    await Effect.runPromise(journal.appendWithCheckpoint(0, [record()], await saved(1), changes))
    expect(await Effect.runPromise(journal.readMessage(message.id))).toEqual({ position: 1, record: record() })
    await expect(Effect.runPromise(journal.append(1, [record("two"), record()]))).rejects.toThrow()
    expect(await Effect.runPromise(journal.readMessage("two"))).toBeUndefined()
    expect((await Effect.runPromise(journal.read)).length).toBe(1)
    expect((await Effect.runPromise(journal.readCheckpoint))!.position).toBe(1)
    await expect(Effect.runPromise(journal.append(1, [record("same"), record("same")]))).rejects.toThrow()
    expect(await Effect.runPromise(journal.readMessage("same"))).toBeUndefined()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("thread initialization and indexed version reads avoid unrelated payloads", async () => {
  const db = new Database(":memory:"), driver = driverFor(db), journal = synchronousJournal({ actor: "versions", driver, eventInlineBytes: 64, checkpointChunkBytes: 128 })
  try {
    await Effect.runPromise(initializeThread(journal, creation))
    await Effect.runPromise(initializeThread(journal, creation))
    await Effect.runPromise(journal.append(1, [record()]))
    db.exec("DELETE FROM experimental_event_chunks WHERE seq=1 AND ordinal=0")
    expect(await Effect.runPromise(journal.readFirst)).toMatchObject({ event: creation })
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ position: 2, pendingEffects: 0, version: "v1" })
    await Effect.runPromise(updateThreadVersion(journal, address, "v2"))
    await Effect.runPromise(updateThreadVersion(journal, address, "v2"))
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ position: 3, pendingEffects: 0, version: "v2" })
    await expect(Effect.runPromise(journal.readMessage(message.id))).rejects.toThrow()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("indexed receipts reject dangling or mismatched pointers and corrupted payloads", async () => {
  const db = new Database(":memory:"), journal = synchronousJournal({ actor: "corrupt", driver: driverFor(db), eventInlineBytes: 64, checkpointChunkBytes: 128 })
  try {
    await Effect.runPromise(journal.append(0, [record(), record("two")]))
    db.exec("UPDATE experimental_messages SET seq=1 WHERE id='one'")
    await expect(Effect.runPromise(journal.readMessage("one"))).rejects.toThrow("differs")
    db.exec("UPDATE experimental_messages SET seq=999 WHERE id='one'")
    await expect(Effect.runPromise(journal.readMessage("one"))).rejects.toThrow("missing")
    db.exec("UPDATE experimental_messages SET seq=0 WHERE id='one'")
    db.exec("DELETE FROM experimental_event_chunks WHERE seq=0 AND ordinal=0")
    await expect(Effect.runPromise(journal.readMessage("one"))).rejects.toThrow()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("message envelopes validate before writes and identities obey configured row budgets", async () => {
  const db = new Database(":memory:"), journal = synchronousJournal({ actor: "bounded", driver: driverFor(db), limits: { maxRowBytes: 512 } })
  try {
    for (const invalid of [
      { event: { type: "Other" }, message },
      { ...record(), message: { ...message, id: "" } },
      { ...record(), message: { ...message, extra: true } },
      record("漢".repeat(512)),
    ]) await expect(Effect.runPromise(journal.append(0, [invalid as Recorded<object>]))).rejects.toThrow()
    expect(await Effect.runPromise(journal.readFirst)).toBeUndefined()
    await Effect.runPromise(journal.append(0, [record("valid")]))
    expect((await Effect.runPromise(journal.readMessage("valid")))!.position).toBe(1)
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("stored journals backfill inline and chunked receipt indexes once per actor", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let journal = synchronousJournal({ actor: "upgrade", driver, eventInlineBytes: 256, checkpointChunkBytes: 128 })
  await Effect.runPromise(journal.append(0, [record("inline", "small"), record("chunked")]))
  await Effect.runPromise(journal.close)
  db.exec("DROP TABLE experimental_messages")
  db.exec("DROP TABLE stored_journal_message_indexes")
  journal = synchronousJournal({ actor: "other", driver })
  await Effect.runPromise(journal.append(0, [record("chunked", "other actor")]))
  await Effect.runPromise(journal.close)
  journal = synchronousJournal({ actor: "upgrade", driver })
  try {
    expect(await Effect.runPromise(journal.readMessage("inline"))).toEqual({ position: 1, record: record("inline", "small") })
    expect(await Effect.runPromise(journal.readMessage("chunked"))).toEqual({ position: 2, record: record("chunked") })
    await Effect.runPromise(journal.close)
    db.exec("DELETE FROM experimental_event_chunks WHERE seq=1 AND actor='upgrade' AND ordinal=0")
    journal = synchronousJournal({ actor: "upgrade", driver })
    expect(await Effect.runPromise(journal.readMessage("inline"))).toEqual({ position: 1, record: record("inline", "small") })
    await expect(Effect.runPromise(journal.readMessage("chunked"))).rejects.toThrow()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

for (const corrupt of [false, true]) test(`receipt backfill rolls back on ${corrupt ? "corrupt payload" : "duplicate identity"}`, async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  const journal = synchronousJournal({ actor: "invalid-upgrade", driver, eventInlineBytes: corrupt ? 64 : 100_000 })
  try {
    await Effect.runPromise(journal.append(0, [record("one"), record("two")]))
    await Effect.runPromise(journal.close)
    db.exec("DROP TABLE experimental_messages")
    db.exec("DROP TABLE stored_journal_message_indexes")
    if (corrupt) db.exec("DELETE FROM experimental_event_chunks WHERE seq=1 AND ordinal=0")
    else db.query("UPDATE experimental_events SET event=? WHERE seq=1").run(JSON.stringify(record("one")))
    expect(() => synchronousJournal({ actor: "invalid-upgrade", driver })).toThrow()
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('experimental_messages','stored_journal_message_indexes')").all()).toEqual([])
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM experimental_events").get()!.n).toBe(2)
  } finally { await Effect.runPromise(journal.close); db.close() }
})
