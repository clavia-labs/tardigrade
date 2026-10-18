import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import { Effect, Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { prepareDocumentInput } from "@clavia/tardigrade-core/services/tree-state"
import { treeActorFixture, TreeEvent } from "../properties/runtime/tree-state"
import { waitFor } from "../fixtures/wait"

const State = Schema.Struct({ messages: Schema.Array(Schema.Struct({ text: Schema.String })) })
const driverFor = (db: Database): SyncSqlite => ({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() })

test("stored input acceptance rolls back, reopens A after B, then releases A with completion", async () => {
  const db = new Database(":memory:"), native = driverFor(db)
  let fail = true, failRelease = false
  const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
    if (fail && sql.startsWith("INSERT INTO stored_journal_events")) throw new Error("Injected journal write failure")
    if (failRelease && sql.startsWith("DELETE FROM stored_journal_inputs")) throw new Error("Injected release failure")
    return native.execute(sql, parameters)
  } }
  let journal = synchronousJournal<{ type: string }>({ actor: "stored", driver, cacheBytes: 0 })
  const bound = journal.storedValues!.bind(State), a = bound.initial({ messages: [{ text: "A" }] })
  const ref = { atom: "model", act: "model", seq: 1 }
  const request = { act: "model", ...prepareDocumentInput({ messages: a.selectEach(["messages"], ["text"], { start: 0, end: 1 }) }) }
  const changes = { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] }, put: [{ ref, request }] }
  await expect(Effect.runPromise(journal.append(0, [{ event: { type: "Accepted" } }], changes))).rejects.toThrow("Injected")
  expect(await Effect.runPromise(journal.read)).toEqual([])
  expect(await Effect.runPromise(journal.readInputs)).toEqual([])
  expect(journal.grove.owners("")).toEqual([])
  expect(journal.grove.stats().stagedNodes).toBeGreaterThan(0)
  fail = false
  await Effect.runPromise(journal.append(0, [{ event: { type: "Accepted" } }], changes))
  const b = a.set(["messages", 0, "text"], "B")
  await Effect.runPromise(journal.append(1, [{ event: { type: "Advanced" } }], { documents: { references: [{ name: "history", reference: encodeReference(b.reference!) }] } }))
  await Effect.runPromise(journal.collect)
  expect(journal.storedValues!.resolve(request)).toEqual({ messages: ["A"] })
  await Effect.runPromise(journal.close)
  journal = synchronousJournal({ actor: "stored", driver, cacheBytes: 0 })
  const accepted = (await Effect.runPromise(journal.readInputs))[0]!
  expect(journal.storedValues!.resolve(accepted.request)).toEqual({ messages: ["A"] })
  expect(journal.storedValues!.bind(State).open(encodeReference(b.reference!)).read(["messages", 0, "text"])).toBe("B")
  failRelease = true
  await expect(Effect.runPromise(journal.append(2, [{ event: { type: "Completed" } }], { remove: [ref] }))).rejects.toThrow("Injected")
  expect((await Effect.runPromise(journal.readInputs)).length).toBe(1)
  expect(journal.storedValues!.resolve(request)).toEqual({ messages: ["A"] })
  failRelease = false
  await Effect.runPromise(journal.append(2, [{ event: { type: "Completed" } }], { remove: [ref] }))
  await Effect.runPromise(journal.collect)
  expect(await Effect.runPromise(journal.readInputs)).toEqual([])
  expect(() => journal.grove.view(decodeReference(encodeReference(a.reference!)), State).materialize()).toThrow("persisted")
  expect(journal.grove.stats()).toMatchObject({ stagedNodes: 0, activeLeases: 0 })
  await Effect.runPromise(journal.close); db.close()
})

test("stored journal rejects stale publication and preserves projection holders", async () => {
  const db = new Database(":memory:"), driver = driverFor(db)
  const journal = synchronousJournal<{ type: string }>({ actor: "holders", driver })
  const bound = journal.storedValues!.bind(State), a = bound.initial({ messages: [{ text: "A" }] })
  await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] } }))
  const stale = synchronousJournal<{ type: string }>({ actor: "holders", driver })
  const holder = {}
  journal.storedValues!.hold(holder, "frame", encodeReference(a.reference!))
  const b = a.set(["messages", 0, "text"], "B")
  await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: encodeReference(b.reference!) }] } }))
  const c = stale.storedValues!.bind(State).open(encodeReference(a.reference!)).set(["messages", 0, "text"], "C")
  await expect(Effect.runPromise(stale.append(0, [{ event: { type: "Stale" } }], { documents: { references: [{ name: "history", reference: encodeReference(c.reference!) }] } }))).rejects.toThrow("changed")
  expect(await Effect.runPromise(journal.read)).toEqual([])
  await Effect.runPromise(journal.collect)
  expect(journal.grove.view(decodeReference(encodeReference(a.reference!)), State).materialize()).toEqual({ messages: [{ text: "A" }] })
  journal.storedValues!.release(holder)
  await Effect.runPromise(journal.collect)
  expect(() => journal.grove.view(decodeReference(encodeReference(a.reference!)), State).materialize()).toThrow()
  await Effect.runPromise(stale.close); await Effect.runPromise(journal.close); db.close()
})

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

test("legacy journal data is rejected before new journal records can be written", () => {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE experimental_events(actor TEXT,seq INTEGER,event TEXT)")
  db.query("INSERT INTO experimental_events VALUES('legacy',0,'{}')").run()
  expect(() => synchronousJournal({ actor: "legacy", driver: driverFor(db) })).toThrow("migration")
  expect(db.query("SELECT name FROM sqlite_master WHERE name='stored_journal_events'").all()).toEqual([])
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

test("Core sessions preserve native Grove documents through generated edits and reopen", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string(), { maxLength: 20 }), fc.string(), async (texts, replacement) => {
    const db = new Database(":memory:"), driver = driverFor(db)
    const journal = synchronousJournal<{ type: string }>({ actor: "native-documents", driver, cacheBytes: 0 })
    try {
      const NativeState = Schema.Struct({ ...State.fields, note: Schema.optionalKey(Schema.String) })
      const bound = journal.storedValues.bind(NativeState)
      let document = bound.initial({ messages: texts.map(text => ({ text })), note: replacement })
      const versions = [document]
      document = document.append(["messages"], [{ text: replacement }]); versions.push(document)
      document = document.set(["messages", 0, "text"], replacement); versions.push(document)
      document = document.splice(["messages"], 0, 1, [{ text: replacement }]); versions.push(document)
      document = document.remove(["note"]); versions.push(document)
      document = document.batch(edit => { edit.append(["messages"], [{ text: replacement }]) }); versions.push(document)
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
      if (sql.startsWith("INSERT INTO stored_journal_events")) duringWrite()
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
