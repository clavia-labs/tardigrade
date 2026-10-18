import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, tree, effectAtom, event, encodeCheckpoint, checkpointDigest } from "@clavia/tardigrade-core"
import { decodeReference, encodeReference } from "@tardie/grove"
import { bunBackup, bunJournal, createBunHost, observeBunThread, restoreHostCheckpoint, DEFAULT_BUN_BUSY_TIMEOUT_MS } from "../../src/bun"
import { bunThreadPath } from "../../src/bun/observe"

const Added = event({ type: "Added", amount: Schema.Int })
const count = durableAtom({ name: "native.count", input: Added, schema: tree(Schema.Struct({ count: Schema.Int })), initial: { count: 0 }, reduce: (state, event) => state.set(["count"], state.read(["count"]) + event.amount) })
const actor = defineActor("native-backup", Effect.succeed({
  atom: effectAtom(get => ({ view: get(count).read(["count"]), events: {}, acts: {} })),
  methods: { add: actorMethod({ inputSchema: Schema.Int, outputSchema: Schema.Int, onReceive: Added.from(amount => ({ amount })), result: (_, get) => ({ status: "completed", output: get(count).read(["count"]) }) }) },
}))

test("default Bun host observes and restores native documents and message receipts from backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-host-backup-")), storage = join(root, "host"), restored = join(root, "restored")
  const backup = bunBackup({ directory: join(root, "archives"), namespace: "native" })
  const open = (storage: string) => Effect.runPromise(createBunHost({ actor, storage, backup, actorContext: Context.pick(), checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, checkpointTree: { collectEvery: 1 }, services: () => Layer.empty }))
  let host = await open(storage)
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "counter" }))
    const receipt = await Effect.runPromise(thread.invoke("add", 3, { id: "one" }))
    await Effect.runPromise(thread.wait)
    expect(thread.getState().view).toBe(3)
    const observer = observeBunThread({ storage, coordinate: thread.coordinate, schema: Added })
    try {
      await Effect.runPromise(observer.refresh)
      expect([...observer.records.get()].some(record => record.message?.id === "one")).toBe(true)
    } finally { await Effect.runPromise(observer.close) }
    const db = new Database(bunThreadPath(storage, thread.coordinate), { readonly: true })
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE name='experimental_events'").get()).not.toBeNull()
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_value_owners").get()!.n).toBeGreaterThan(0)
    } finally { db.close() }
    const saved = await Effect.runPromise(host.backup)
    await Effect.runPromise(host.close)
    await Effect.runPromise(restoreHostCheckpoint({ actor: actor.actorName, storage: restored, backup, id: saved.id }))
    host = await open(restored)
    const reopened = await Effect.runPromise(host.getThread({ instance: "main", thread: "counter" }))
    expect(reopened).toBeDefined()
    expect(await Effect.runPromise(reopened!.invoke("add", 3, { id: "one" }))).toEqual(receipt)
    expect(reopened!.getState().view).toBe(3)
    await Effect.runPromise(reopened!.invoke("add", 4, { id: "two" }))
    expect(reopened!.getState().view).toBe(7)
  } finally { await Effect.runPromise(host.close); await rm(root, { recursive: true, force: true }) }
})

test("default Bun journal exposes native policies and rejects unsupported SQL transforms", () => {
  const journal = bunJournal({ filename: ":memory:", actor: "native", busyTimeout: 17, checkpointTree: { collectEvery: 2 } })
  try {
    expect(journal.sqlite.busyTimeoutMs).toBe(17)
    expect(journal.collection.everyCheckpoints).toBe(2)
    expect(DEFAULT_BUN_BUSY_TIMEOUT_MS).toBe(5000)
    expect(journal.storedValues).toBeDefined()
  } finally { Effect.runSync(journal.close) }
  expect(() => bunJournal({ filename: ":memory:", actor: "invalid", transformQueryNames: name => name })).toThrow("transforms")
})

test("default Bun journal opens 0.50 events without replacing the event table", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-bun-format-")), filename = join(root, "legacy.sqlite")
  const db = new Database(filename)
  try {
    db.exec("CREATE TABLE experimental_events(actor TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(actor,seq)) WITHOUT ROWID")
    const record = { event: { type: "Existing" }, recordedAt: 123 }
    db.query("INSERT INTO experimental_events VALUES(?,?,?)").run("events", 0, JSON.stringify(record))
    const journal = bunJournal({ filename, actor: "events" })
    try {
      expect(await Effect.runPromise(journal.read)).toEqual([record])
      await Effect.runPromise(journal.append(1, [{ event: { type: "New" } }]))
      expect(db.query<{ event: string }, []>("SELECT event FROM experimental_events WHERE seq=0").get()!.event).toBe(JSON.stringify(record))
      expect(db.query("SELECT name FROM sqlite_master WHERE name='stored_journal_events'").get()).toBeNull()
    } finally { await Effect.runPromise(journal.close) }
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("default Bun journal rejects a legacy checkpoint at position zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-bun-checkpoint-format-")), filename = join(root, "legacy.sqlite")
  const db = new Database(filename)
  try {
    db.exec("CREATE TABLE checkpoint(id INTEGER PRIMARY KEY,position INTEGER)")
    db.exec("INSERT INTO checkpoint VALUES(1,0)")
    expect(() => bunJournal({ filename, actor: "events" })).toThrow("requires migration")
    expect(db.query("SELECT name FROM sqlite_master WHERE name='experimental_events'").get()).toBeNull()
    expect(db.query<{ position: number }, []>("SELECT position FROM checkpoint").get()!.position).toBe(0)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("default collection cadence survives reopening and collects obsolete document versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-bun-collection-")), filename = join(root, "native.sqlite")
  const state = Schema.Struct({ value: Schema.String })
  const open = () => bunJournal({ filename, actor: "events", checkpointTree: { collectEvery: 2, cacheBytes: 0 } })
  let journal = open()
  const checkpoint = async (root: string) => {
    const payload = encodeCheckpoint({ position: 0, durable: [{ name: "state", position: 0, reference: root, state: { _tag: "DocumentState", reference: root } }], operations: [] })
    await Effect.runPromise(journal.appendWithCheckpoint(0, [], { position: 0, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }, { documents: { references: [{ name: "state", reference: root }] } }))
  }
  try {
    const first = journal.storedValues.bind(state).initial({ value: "A" })
    await checkpoint(encodeReference(first.reference!))
    await Effect.runPromise(journal.close)
    journal = open()
    const second = journal.storedValues.bind(state).open(encodeReference(first.reference!)).set(["value"], "B")
    await checkpoint(encodeReference(second.reference!))
    expect(() => journal.grove.view(decodeReference(encodeReference(first.reference!)), state).materialize()).toThrow()
    expect(journal.grove.view(decodeReference(encodeReference(second.reference!)), state).materialize()).toEqual({ value: "B" })
  } finally { await Effect.runPromise(journal.close); await rm(root, { recursive: true, force: true }) }
})
