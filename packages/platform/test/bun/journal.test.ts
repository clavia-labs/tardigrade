import fc from "fast-check"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Schema, Deferred } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import { type SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { prepareDocumentInput } from "@clavia/tardigrade-core/services/tree-state"
import { treeActorFixture, TreeEvent } from "../properties/runtime/tree-state"
import { waitFor } from "../fixtures/wait"
import { checkpointDigest, encodeCheckpoint, effectKey, type EffectRef, type Recorded, watchdogKey, RuntimeError, type Alarm } from "@clavia/tardigrade-core"
import { initializeThread, updateThreadVersion } from "@clavia/tardigrade-core/services/journal/thread"
import { schedulerProperties, schedulerAcknowledgments } from "../properties/scheduler/wakes"
import { journalProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/bun/sqlite"

const State = Schema.Struct({ messages: Schema.Array(Schema.Struct({ text: Schema.String })) })
const driverFor = (db: Database): SyncSqlite => ({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() })

test("holders acquired during asynchronous record preparation survive staging acknowledgement", async () => {
  const db = new Database(":memory:"), journal = synchronousJournal<{ type: string }>({ actor: "late-holder", driver: driverFor(db), cacheBytes: 0 })
  const bound = journal.storedValues.bind(State), published = bound.initial({ messages: [{ text: "published" }] }), holder = {}
  try {
    const committing = Effect.runPromise(journal.append(0, [{ event: { type: "Added" } }], { documents: { references: [{ name: "history", reference: encodeReference(published.reference!) }] } }))
    const late = bound.initial({ messages: [{ text: "late projection" }] })
    journal.storedValues.hold(holder, "frame", encodeReference(late.reference!))
    await committing
    await Effect.runPromise(journal.collect)
    expect(journal.storedValues.read(encodeReference(late.reference!))).toEqual({ messages: [{ text: "late projection" }] })
    journal.storedValues.release(holder)
    await Effect.runPromise(journal.collect)
    expect(() => journal.grove.view(decodeReference(encodeReference(late.reference!)), State).materialize()).toThrow()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

for (const cleanup of [false, true]) test(`actor stored references survive checkpoint, restart and ${cleanup ? "cancellation cleanup" : "completion"}`, async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let journal = synchronousJournal<typeof TreeEvent.Type>({ actor: "actor", driver, cacheBytes: 0 })
  const calls: { phase: string; length: number; first: string | undefined; ref: unknown }[] = []
  const observe: Parameters<typeof treeActorFixture>[1] = (phase, input, ref) => Effect.sync(() => { calls.push({ phase, length: input.messages.length, first: input.messages[0]?.text, ref }) })
  let live = await Effect.runPromise(treeActorFixture(journal, observe))
  try {
    await Effect.runPromise(live.seed)
    await Effect.runPromise(live.store.checkpoint)
    await Effect.runPromise(live.start)
    await waitFor(() => Promise.resolve(calls), values => values.length > 0)
    const accepted = (await Effect.runPromise(journal.readInputs))[0]!
    expect(JSON.stringify(accepted).length).toBeLessThan(1500)
    await Effect.runPromise(live.append)
    if (cleanup) {
      await Effect.runPromise(live.store.cancel(accepted.ref, "stop"))
      await waitFor(() => Promise.resolve(calls), values => values.some(value => value.phase === "cleanup"))
      await Effect.runPromise(live.store.checkpoint)
    }
    await Effect.runPromise(live.store.close)
    await Effect.runPromise(journal.close)
    journal = synchronousJournal({ actor: "actor", driver, cacheBytes: 0 })
    live = await Effect.runPromise(treeActorFixture(journal, observe))
    await waitFor(() => Promise.resolve(calls), values => values.length >= (cleanup ? 3 : 2))
    expect(calls.every(call => call.length === 4096 && call.first === `0:${"x".repeat(2048)}`)).toBe(true)
    expect(calls.every(call => JSON.stringify(call.ref) === JSON.stringify(accepted.ref))).toBe(true)
    expect(live.store.getState().view.count).toBe(4097)
    await Effect.runPromise(cleanup ? live.finishCleanup : live.finish)
    await Effect.runPromise(live.store.wait)
    await Effect.runPromise(live.store.checkpoint)
    await Effect.runPromise(journal.collect)
    expect(await Effect.runPromise(journal.readInputs)).toEqual([])
    expect(() => journal.grove.view(decodeReference(accepted.request.selections![0]!.reference), Schema.Array(Schema.Json)).materialize()).toThrow()
    expect(journal.grove.stats()).toMatchObject({ stagedNodes: 0, activeLeases: 0 })
  } finally { await Effect.runPromise(live.store.close); await Effect.runPromise(journal.close); db.close() }
}, 30000)

test("legacy materialized checkpoints are rejected before event records change", () => {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE checkpoint(id INTEGER PRIMARY KEY,position INTEGER)")
  db.exec("INSERT INTO checkpoint VALUES(1,0)")
  expect(() => synchronousJournal({ actor: "legacy", driver: driverFor(db) })).toThrow("migration")
  expect(db.query("SELECT name FROM sqlite_master WHERE name='experimental_events'").all()).toEqual([])
  db.close()
})

test("journal append rejects an enclosing Grove transaction before changing publication state", async () => {
  const db = new Database(":memory:"), journal = synchronousJournal<{ type: string }>({ actor: "outer", driver: driverFor(db) })
  const a = journal.storedValues!.bind(State).initial({ messages: [] })
  const changes = { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] } }
  expect(() => journal.grove.transaction(() => Effect.runSync(journal.append(0, [{ event: { type: "Added" } }], changes)))).toThrow("own the native transaction")
  expect(journal.grove.owners("")).toEqual([])
  await Effect.runPromise(journal.append(0, [{ event: { type: "Added" } }], changes))
  expect((await Effect.runPromise(journal.read)).length).toBe(1)
  await Effect.runPromise(journal.close); db.close()
})

test("Unicode actor owner prefixes reopen and release correctly", async () => {
  const db = new Database(":memory:"), driver = driverFor(db), actor = "actor-\u{1F332}"
  let journal = synchronousJournal<{ type: string }>({ actor, driver })
  const a = journal.storedValues!.bind(State).initial({ messages: [] })
  await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] } }))
  await Effect.runPromise(journal.close)
  journal = synchronousJournal({ actor, driver })
  const b = journal.storedValues!.bind(State).open(encodeReference(a.reference!)).append(["messages"], [{ text: "B" }])
  await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: encodeReference(b.reference!) }] } }))
  expect(journal.grove.owners(JSON.stringify([actor, "state"])).length).toBe(1)
  await Effect.runPromise(journal.collect)
  expect(journal.storedValues!.bind(State).open(encodeReference(b.reference!)).length(["messages"])).toBe(1)
  await Effect.runPromise(journal.close); db.close()
})

test("whole-value checkpoints release previous tree owners only after commit", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async note => {
    const db = new Database(":memory:"), base = driverFor(db)
    let fail = false
    const driver: SyncSqlite = { ...base, execute: (sql, parameters) => {
      if (fail && sql.startsWith("INSERT INTO journal_checkpoint_chunks")) throw new Error("Injected checkpoint failure")
      return base.execute(sql, parameters)
    } }
    let journal = synchronousJournal<{ type: string }>({ actor: "values", driver, cacheBytes: 0 })
    const save = async (state: unknown, reference?: string) => {
      const payload = encodeCheckpoint({ position: 0, durable: [{ name: "control", position: 0, state, ...(reference ? { reference } : {}) }], operations: [] })
      return { position: 0, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
    }
    const owner = JSON.stringify(["values", "state"]) + "/control"
    try {
      const old = journal.storedValues.bind(State).initial({ messages: [{ text: note }] }), reference = encodeReference(old.reference!)
      const original = await save({ _tag: "DocumentState", reference }, reference)
      await Effect.runPromise(journal.appendWithCheckpoint(0, [], original, { documents: { references: [{ name: "control", reference }] } }))
      await Effect.runPromise(journal.close)
      journal = synchronousJournal({ actor: "values", driver, cacheBytes: 0 })
      const replacement = await save({ _tag: "ValueState", value: { messages: [{ text: note }] } })
      fail = true
      await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [], replacement))).rejects.toThrow("Injected checkpoint failure")
      expect(journal.grove.owner(owner)).toEqual(decodeReference(reference))
      expect(await Effect.runPromise(journal.readCheckpoint)).toEqual(original)
      fail = false
      await Effect.runPromise(journal.appendWithCheckpoint(0, [], replacement))
      expect(journal.grove.owner(owner)).toBeNull()
      await Effect.runPromise(journal.collect)
      expect(() => journal.storedValues.read(reference)).toThrow()
      expect(await Effect.runPromise(journal.readCheckpoint)).toEqual(replacement)
      const next = journal.storedValues.bind(State).initial({ messages: [{ text: note + "next" }] }), nextReference = encodeReference(next.reference!)
      await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "control", reference: nextReference }] } }))
      expect(journal.grove.owner(owner)).toEqual(next.reference!)
    } finally { await Effect.runPromise(journal.close); db.close() }
  }), { numRuns: 20, includeErrorInReport: true })
})

test("Core session bindings preserve document identity through journal publication", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), fc.string(), async (texts, replacement) => {
    const db = new Database(":memory:"), driver = driverFor(db)
    const journal = synchronousJournal<{ type: string }>({ actor: "native-documents", driver, cacheBytes: 0 })
    try {
      const NativeState = Schema.Struct({ ...State.fields, note: Schema.optionalKey(Schema.String) })
      const bound = journal.storedValues.bind(NativeState)
      let document = bound.initial({ messages: texts.map(text => ({ text })), note: replacement })
      const versions = [document]
      document = document.set(["note"], replacement + ":next"); versions.push(document)
      const holder = {}
      for (const [index, version] of versions.entries()) journal.storedValues.hold(holder, String(index), encodeReference(version.reference!))
      for (const version of versions) {
        expect(bound.check(version)).toBe(version)
        expect(() => journal.storedValues.bind(NativeState).check(version)).toThrow("foreign")
        await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "state", reference: encodeReference(version.reference!) }] } }))
        const reopened = journal.storedValues.bind(NativeState).open(encodeReference(version.reference!))
        expect(reopened.read([])).toEqual(version.read([]))
        expect(encodeReference(reopened.reference)).toBe(encodeReference(version.reference!))
      }
      expect(versions[0]!.read([])).toEqual({ messages: texts.map(text => ({ text })), note: replacement })
      journal.storedValues.release(holder)
    } finally { await Effect.runPromise(journal.close); db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})

test("journal cleanup preserves held drafts created during a native commit", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async text => {
    const db = new Database(":memory:"), native = driverFor(db)
    let duringWrite = () => {}
    const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
      if (sql.startsWith("INSERT INTO experimental_events")) duringWrite()
      return native.execute(sql, parameters)
    } }
    const journal = synchronousJournal<{ type: string }>({ actor: "late-draft", driver, cacheBytes: 0 })
    const holder = {}, value = { messages: [{ text }] }
    let reference: string | undefined
    duringWrite = () => {
      const document = journal.storedValues.bind(State).initial(value)
      reference = encodeReference(document.reference)
      journal.storedValues.hold(holder, "draft", reference)
    }
    try {
      await Effect.runPromise(journal.append(0, [{ event: { type: "Recorded" } }]))
      expect((await Effect.runPromise(journal.read))).toHaveLength(1)
      expect(journal.storedValues.read(reference!)).toEqual(value)
      await Effect.runPromise(journal.collect)
      expect(journal.storedValues.read(reference!)).toEqual(value)
      journal.storedValues.release(holder)
      await Effect.runPromise(journal.collect)
      expect(() => journal.storedValues.read(reference!)).toThrow()
    } finally { journal.storedValues.release(holder); await Effect.runPromise(journal.close); db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})

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
    for (const table of ["experimental_event_chunks", "journal_accepted_input_chunks", "journal_checkpoint_chunks"]) {
      expect(count(db, table)).toBeGreaterThan(1)
      expect(db.query<{ n: number }, []>(`SELECT MAX(length(payload)) n FROM ${table}`).get()!.n).toBeLessThanOrEqual(511)
    }
    expect(JSON.parse(db.query<{ event: string }, []>("SELECT event FROM experimental_events").get()!.event)).toMatchObject({ event: { type: "Large" }, byteLength: expect.any(Number), chunkCount: expect.any(Number) })
    await Effect.runPromise(journal.close)
    journal = synchronousJournal({ actor: "chunks", driver, checkpointChunkBytes: 511, eventInlineBytes: 256, limits: { maxRowBytes: 4096 } })
    expect(await Effect.runPromise(journal.read)).toEqual([{ event: { type: "Large", text } }])
    expect(await Effect.runPromise(journal.readInputs)).toEqual([{ ref, request }])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(saved.payload)
    const before = count(db, "journal_accepted_input_chunks")
    await Effect.runPromise(journal.append(1, [], { put: [{ ref, request }] }))
    expect(count(db, "journal_accepted_input_chunks")).toBe(before)
    await expect(Effect.runPromise(journal.append(1, [{ event: { type: "Invalid" } }], { put: [{ ref, request: { ...request, input: { text: "changed" } } }] }))).rejects.toThrow("cannot change")
    const small = await checkpoint(2, "small")
    await Effect.runPromise(journal.appendWithCheckpoint(1, [{ event: { type: "Completed" } }], small, { remove: [ref] }))
    expect(count(db, "journal_accepted_input_chunks")).toBe(0)
    expect(count(db, "journal_checkpoint_chunks")).toBe(1)
    expect(await Effect.runPromise(journal.readAfter(1))).toEqual([{ event: { type: "Completed" } }])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(small.payload)
    expect(journal.chunking).toMatchObject({ checkpointChunkBytes: 511, eventInlineBytes: 256, maxRowBytes: 4096 })
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("partial event and replacement checkpoint writes roll back chunks and Grove owners", async () => {
  const db = new Database(":memory:"), native = driverFor(db)
  let failTable: string | undefined = "experimental_event_chunks"
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (failTable && sql.startsWith(`INSERT INTO ${failTable}`) && Number(parameters[failTable === "journal_checkpoint_chunks" ? 0 : 2]) === 1) throw new Error("Injected partial chunk failure")
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
    for (const table of ["experimental_events", "experimental_event_chunks", "journal_accepted_inputs", "journal_accepted_input_chunks", "journal_checkpoints", "journal_checkpoint_chunks"]) expect(count(db, table)).toBe(0)
    expect(journal.grove.owners("")).toEqual([])
    expect(journal.grove.stats().stagedNodes).toBeGreaterThan(0)
    failTable = undefined
    await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Accepted", text } }], first, changes))
    const b = a.set(["value"], "B"), next = await checkpoint(2, text + "next", encodeReference(b.reference!))
    failTable = "journal_checkpoint_chunks"
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
      const table = kind === "event" ? "experimental_event_chunks" : kind === "input" ? "journal_accepted_input_chunks" : "journal_checkpoint_chunks", header = kind === "event" ? "experimental_events" : kind === "input" ? "journal_accepted_inputs" : "journal_checkpoints"
      if (corruption === "missing") db.exec(`DELETE FROM ${table} WHERE ordinal=0`)
      if (corruption === "ordinal") db.exec(`UPDATE ${table} SET ordinal=9999 WHERE ordinal=0`)
      if (corruption === "length") db.exec(kind === "event" ? "UPDATE experimental_events SET event=json_set(event,'$.byteLength',json_extract(event,'$.byteLength')+1)" : `UPDATE ${header} SET byte_length=byte_length+1`)
      if (corruption === "count") db.exec(kind === "event" ? "UPDATE experimental_events SET event=json_set(event,'$.chunkCount',json_extract(event,'$.chunkCount')+1)" : `UPDATE ${header} SET chunk_count=chunk_count+1`)
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
    if ((sql.startsWith("INSERT INTO journal_") || sql.startsWith("INSERT INTO experimental_"))) {
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
  db.exec("CREATE TABLE experimental_events(actor TEXT,seq INTEGER,event TEXT,PRIMARY KEY(actor,seq))")
  db.exec("CREATE TABLE stored_journal_inputs(actor TEXT,ref TEXT,input TEXT,PRIMARY KEY(actor,ref))")
  db.exec("CREATE TABLE stored_journal_checkpoints(actor TEXT PRIMARY KEY,position INTEGER,payload BLOB,digest TEXT)")
  const input = { ref, request: { act: ref.act, input: { text: "legacy" } } }
  db.query("INSERT INTO experimental_events VALUES(?,?,?)").run("upgrade", 0, JSON.stringify({ event: { type: "Legacy" } }))
  db.query("INSERT INTO stored_journal_inputs VALUES(?,?,?)").run("upgrade", effectKey(ref), JSON.stringify(input))
  db.query("INSERT INTO stored_journal_checkpoints VALUES(?,?,?,?)").run("upgrade", 1, saved.payload, saved.digest)
  const journal = synchronousJournal<{ type: string; text?: string }>({ actor: "upgrade", driver, checkpointChunkBytes: 127, eventInlineBytes: 128 })
  try {
    expect(await Effect.runPromise(journal.read)).toEqual([{ event: { type: "Legacy" } }])
    expect(await Effect.runPromise(journal.readInputs)).toEqual([input])
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(saved.payload)
    await Effect.runPromise(journal.append(1, [{ event: { type: "Large", text } }], { put: [input] }))
    expect(count(db, "journal_accepted_input_chunks")).toBe(0)
    expect((await Effect.runPromise(journal.readAfter(1)))[0]!.event).toEqual({ type: "Large", text })
    expect(count(db, "experimental_event_chunks")).toBeGreaterThan(1)
  } finally { await Effect.runPromise(journal.close); db.close() }
})

const message = { id: "one", from: { kind: "external" as const, id: "sender" } }
const record = (id = message.id, text = "é漢字".repeat(1024)) => ({ event: { type: "MessageReceived" as const, body: { type: "Added", text } }, message: { ...message, id } })
const address = { actor: "counter", instance: "main", thread: "one" }
const creation = { type: "ThreadCreated" as const, address, parent: null, depth: 0, placement: "independent" as const, version: "v1" }
const saved = async (position: number) => {
  const payload = encodeCheckpoint({ position, durable: [], operations: [] })
  return { position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
}

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

test("stored journals backfill inline and chunked receipt indexes once per database", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let journal = synchronousJournal({ actor: "upgrade", driver, eventInlineBytes: 256, checkpointChunkBytes: 128 })
  await Effect.runPromise(journal.append(0, [record("inline", "small"), record("chunked")]))
  await Effect.runPromise(journal.close)
  db.exec("DROP TABLE experimental_messages")
  db.exec("UPDATE journal_metadata SET receipts_backfilled=0")
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
    db.exec("UPDATE journal_metadata SET receipts_backfilled=0")
    if (corrupt) db.exec("DELETE FROM experimental_event_chunks WHERE seq=1 AND ordinal=0")
    else db.query("UPDATE experimental_events SET event=? WHERE seq=1").run(JSON.stringify(record("one")))
    expect(() => synchronousJournal({ actor: "invalid-upgrade", driver })).toThrow()
    expect(db.query("SELECT name FROM sqlite_master WHERE name='experimental_messages'").all()).toEqual([])
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM experimental_events").get()!.n).toBe(2)
  } finally { await Effect.runPromise(journal.close); db.close() }
})

const target = { actor: "chat", instance: "one", thread: "main" }
const recoveryRef = { atom: "root", act: "work", seq: 1 }
const retry = (dueAt: number) => ({ event: { type: "RetryScheduled", ref: recoveryRef, attempt: 1, dueAt, reason: null } })
const alarmFor = (set: (at: number | null) => void): typeof Alarm.Service => ({ set: at => Effect.sync(() => set(at)), clear: Effect.sync(() => set(null)) })

for (const property of [schedulerProperties, schedulerAcknowledgments]) test(`stored journal ${property.name}`, async () => {
  const db = new Database(":memory:"), journals: ReturnType<typeof synchronousJournal>[] = []
  let at: number | null = null
  try {
    await property({ open: options => {
      const journal = synchronousJournal({ actor: "scheduler", driver: driverFor(db), scheduler: { ...options, alarm: alarmFor(value => { at = value }) } })
      journals.push(journal)
      return journal.scheduler!
    }, alarmAt: () => Promise.resolve(at) })
  } finally { for (const journal of journals) await Effect.runPromise(journal.close); db.close() }
})

test("watchdog failure rolls back journal chunks, retry wakes, checkpoint and Grove owners", async () => {
  const db = new Database(":memory:"), native = driverFor(db)
  let fail = true, at: number | null = null, flushes = 0
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (fail && sql.startsWith("INSERT INTO watchdogs")) throw new Error("Injected admission failure")
    return native.execute(sql, parameters)
  } }
  const journal = synchronousJournal({ actor: "atomic", driver, eventInlineBytes: 64, checkpointChunkBytes: 64,
    scheduler: { alarm: alarmFor(value => { at = value }), deliver: () => Effect.void },
    watchdog: { target, version: "v1", recover: () => Effect.succeed({ status: "settled", progressCursor: 3 }), invalidate: () => Effect.void },
    flush: Effect.sync(() => { flushes++ }),
  })
  try {
    const document = journal.storedValues.bind(Schema.Struct({ text: Schema.String })).initial({ text: "stored" })
    const payload = encodeCheckpoint({ position: 1, durable: [{ name: "state", position: 1, reference: encodeReference(document.reference!), state: { _tag: "DocumentState", reference: encodeReference(document.reference!) } }], operations: [] })
    const saved = { position: 1, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
    const changes = { documents: { references: [{ name: "state", reference: encodeReference(document.reference!) }] }, put: [{ ref: recoveryRef, request: { act: recoveryRef.act, input: { text: "x".repeat(256) } } }] }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [retry(1)], saved, changes))).rejects.toThrow("admission failure")
    for (const table of ["experimental_events", "experimental_event_chunks", "journal_accepted_inputs", "journal_accepted_input_chunks", "journal_checkpoints", "journal_checkpoint_chunks", "scheduled_wakes", "scheduler_generation", "watchdogs"]) expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0)
    expect(journal.grove.owners("")).toEqual([])
    expect(at).toBeNull()
    expect(flushes).toBe(0)
    fail = false
    await Effect.runPromise(journal.appendWithCheckpoint(0, [retry(1)], saved, changes))
    expect(at as number | null).toBe(1)
    expect(flushes).toBe(1)
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))).toMatchObject({ attempts: 0, progressCursor: 0, recoveryVersion: "v1" })
    await Effect.runPromise(journal.append(1, [{ event: { type: "PromiseSettled", ref: recoveryRef, result: { status: "fulfilled", value: null } } }], { remove: [recoveryRef] }))
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM scheduled_wakes WHERE id LIKE 'effect:%'").get()!.n).toBe(0)
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))!.progressCursor).toBe(2)
    await Effect.runPromise(journal.append(2, [{ event: { type: "ThreadUpdated", version: "v2" } }]))
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))).toMatchObject({ recoveryVersion: "v2", budgetGeneration: 1, attempts: 0 })
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("reopened watchdog precharges recovery and removes its wake after settling", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let at: number | null = null, recovered = 0
  const open = () => {
    const journal: ReturnType<typeof synchronousJournal> = synchronousJournal({ actor: "reopen", driver,
      scheduler: { alarm: alarmFor(value => { at = value }), deliver: () => Effect.suspend(() => journal.watchdog!.alarm) },
      watchdog: { target, recover: () => Effect.gen(function* () {
        const entry = (yield* journal.watchdog!.status).get(watchdogKey(target))!
        expect(entry.attempts).toBe(1)
        recovered++
        return { status: "settled" as const, progressCursor: 1 }
      }), invalidate: () => Effect.void },
    })
    return journal
  }
  let journal = open()
  try {
    await Effect.runPromise(journal.append(0, [{ event: { type: "MessageReceived" } }]))
    await Effect.runPromise(journal.close)
    at = null
    journal = open()
    await Effect.runPromise(journal.readAfter(1))
    expect(at).not.toBeNull()
    await Effect.runPromise(journal.scheduler!.alarm)
    expect(recovered).toBe(1)
    expect((await Effect.runPromise(journal.watchdog!.status)).size).toBe(0)
    expect(at).toBeNull()
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("alarm failure preserves committed retry and reopening restores it after flush", async () => {
  const db = new Database(":memory:"), driver = driverFor(db), order: string[] = []
  let fail = true, at: number | null = null
  const open = () => synchronousJournal({ actor: "alarm", driver, flush: Effect.sync(() => { order.push("flush") }), scheduler: {
    alarm: { set: value => Effect.gen(function* () { order.push("alarm"); if (fail) return yield* Effect.fail(new RuntimeError("Physical alarm unavailable")); at = value }), clear: Effect.void }, deliver: () => Effect.void,
  } })
  let journal = open()
  try {
    await expect(Effect.runPromise(journal.append(0, [retry(1)]))).rejects.toThrow("Physical alarm")
    expect(order).toEqual(["flush", "alarm"])
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM experimental_events").get()!.n).toBe(1)
    await Effect.runPromise(journal.close)
    fail = false
    journal = open()
    expect((await Effect.runPromise(journal.read)).length).toBe(1)
    expect(at as number | null).toBe(1)
    await expect(Effect.runPromise(journal.append(0, [retry(1)]))).rejects.toThrow("conflict")
  } finally { await Effect.runPromise(journal.close); db.close() }
})

for (const mutation of ["schedule", "append"] as const) test(`serialized ${mutation} preserves earliest wake during asynchronous alarm synchronization`, async () => {
  const db = new Database(":memory:"), entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>()
  let first = true, at: number | null = null
  const journal = synchronousJournal({ actor: "order", driver: driverFor(db), scheduler: { alarm: {
    set: value => Effect.gen(function* () { if (first) { first = false; yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release) }; at = value }), clear: Effect.void,
  }, deliver: () => Effect.void } })
  try {
    const pending = Effect.runPromise(journal.scheduler!.schedule({ id: "late", target: null, dueAt: 2000 }))
    await Effect.runPromise(Deferred.await(entered))
    const next = Effect.runPromise(mutation === "schedule" ? journal.scheduler!.schedule({ id: "early", target: null, dueAt: 1000 }) : journal.append(0, [retry(1000)]))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Promise.all([pending, next])
    expect(at as number | null).toBe(1000)
  } finally { await Effect.runPromise(Deferred.succeed(release, undefined)); await Effect.runPromise(journal.close); db.close() }
})

test("recovery callbacks reject suspension and expire transaction handles", async () => {
  const db = new Database(":memory:"), journal = synchronousJournal({ actor: "sync", driver: driverFor(db), scheduler: { alarm: alarmFor(() => {}), deliver: () => Effect.void } })
  try {
    const entry = { target, generation: 1, progressCursor: 0, attempts: 0, consecutiveNoProgress: 0, nextWakeAt: 1, status: "pending" as const }
    await expect(Effect.runPromise(journal.watchdogStorage!.transaction(tx => tx.put("before", entry).pipe(Effect.andThen(Effect.sleep(1)), Effect.andThen(tx.put("after", entry)))))).rejects.toThrow("asynchronous")
    await Bun.sleep(10)
    expect(await Effect.runPromise(journal.watchdogStorage!.transaction(tx => tx.list))).toEqual(new Map())
    const tx = await Effect.runPromise(journal.watchdogStorage!.transaction(tx => Effect.succeed(tx)))
    await expect(Effect.runPromise(tx.put("expired", entry))).rejects.toThrow("expired")
  } finally { await Effect.runPromise(journal.close); db.close() }
})

test("exhausted recovery stays blocked until version adoption renews its budget", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  let attempts = 0, invalidations = 0
  const open = (version: string) => {
    const journal: ReturnType<typeof synchronousJournal> = synchronousJournal({ actor: "budget", driver,
      scheduler: { alarm: alarmFor(() => {}), deliver: () => Effect.suspend(() => journal.watchdog!.alarm) },
      watchdog: { target, version, policy: { maxAttempts: 1 }, recover: () => Effect.sync(() => { attempts++ }).pipe(Effect.andThen(Effect.fail(new RuntimeError("Retryable recovery failure")))), invalidate: () => Effect.sync(() => { invalidations++ }) },
    })
    return journal
  }
  let journal = open("v1")
  try {
    await Effect.runPromise(journal.append(0, [{ event: { type: "MessageReceived" } }]))
    await Effect.runPromise(journal.scheduler!.alarm)
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))).toMatchObject({ status: "blocked", attempts: 1, nextWakeAt: null })
    await Effect.runPromise(journal.append(1, [{ event: { type: "MessageReceived" } }]))
    await Effect.runPromise(journal.scheduler!.alarm)
    expect(attempts).toBe(1)
    await Effect.runPromise(journal.close)
    journal = open("v2")
    await Effect.runPromise(journal.watchdog!.restore)
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))).toMatchObject({ status: "pending", recoveryVersion: "v2", attempts: 0, budgetGeneration: 1 })
    await Effect.runPromise(journal.scheduler!.alarm)
    expect(attempts).toBe(2)
    expect(invalidations).toBe(2)
  } finally { await Effect.runPromise(journal.close); db.close() }
})

for (const property of journalProperties) test(property.name, () => property.run(withSqlite, property.bunRuns), 30_000)
