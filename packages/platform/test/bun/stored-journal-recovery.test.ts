import fc from "fast-check"
import { acknowledgementRetry, acknowledgementOrdering } from "../properties/journal-acknowledgement"
import { encodeReference } from "@tardie/grove"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Deferred, Effect, Schema } from "effect"
import { checkpointDigest, encodeCheckpoint, watchdogKey, RuntimeError, type Alarm } from "@clavia/tardigrade-core"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { schedulerProperties, schedulerAcknowledgments } from "../properties/scheduler/wakes"

const driverFor = (db: Database): SyncSqlite => ({ identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() })
const target = { actor: "chat", instance: "one", thread: "main" }
const ref = { atom: "root", act: "work", seq: 1 }
const retry = (dueAt: number) => ({ event: { type: "RetryScheduled", ref, attempt: 1, dueAt, reason: null } })
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
    if (fail && sql.startsWith("INSERT INTO stored_watchdog_entries")) throw new Error("Injected admission failure")
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
    const changes = { documents: { references: [{ name: "state", reference: encodeReference(document.reference!) }] }, put: [{ ref, request: { act: ref.act, input: { text: "x".repeat(256) } } }] }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [retry(1)], saved, changes))).rejects.toThrow("admission failure")
    for (const table of ["stored_journal_events", "stored_journal_event_chunks", "stored_journal_inputs", "stored_journal_input_chunks", "stored_journal_checkpoints", "stored_journal_checkpoint_chunks", "stored_scheduler_wakes", "stored_scheduler_generation", "stored_watchdog_entries"]) expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0)
    expect(journal.grove.owners("")).toEqual([])
    expect(at).toBeNull()
    expect(flushes).toBe(0)
    fail = false
    await Effect.runPromise(journal.appendWithCheckpoint(0, [retry(1)], saved, changes))
    expect(at as number | null).toBe(1)
    expect(flushes).toBe(1)
    expect((await Effect.runPromise(journal.watchdog!.status)).get(watchdogKey(target))).toMatchObject({ attempts: 0, progressCursor: 0, recoveryVersion: "v1" })
    await Effect.runPromise(journal.append(1, [{ event: { type: "PromiseSettled", ref, result: { status: "fulfilled", value: null } } }], { remove: [ref] }))
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM stored_scheduler_wakes WHERE id LIKE 'effect:%'").get()!.n).toBe(0)
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
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM stored_journal_events").get()!.n).toBe(1)
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


test("provisioning retries restore committed alarms under generated failures", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ failures: fc.integer({ min: 1, max: 4 }), repeats: fc.integer({ min: 0, max: 4 }), now: fc.integer({ min: 1, max: 1_000_000_000 }) }), async options => {
    const db = new Database(":memory:")
    try { await acknowledgementRetry(driverFor(db), options) } finally { db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})

test("acknowledgement serializes competing generated recovery wakes", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 1_000_000 }), async (early, gap) => {
    const db = new Database(":memory:")
    try { await acknowledgementOrdering(driverFor(db), early, gap) } finally { db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})
