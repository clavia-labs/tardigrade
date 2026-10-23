import { strict as assert } from "node:assert"
import { Effect, Schema } from "effect"
import * as fc from "fast-check"
import { atom, createEventLog, journalCommit, versionedEvent, type Recorded } from "@clavia/tardigrade-core"
import { durableAtom, Log, LogSelection, type LogCursor } from "@clavia/tardigrade-core/experimental"
import { memoryJournalReads } from "../fixtures/memory-journal"
import type { sqlJournal } from "../../src/shared/sql-journal"

const Entry = Schema.Struct({ type: Schema.Literal("LogEntry"), text: Schema.String })
const Noise = Schema.Struct({ type: Schema.Literal("LogNoise") })
const Event = Schema.Union([Entry, Noise])
const entries = durableAtom.log({ name: "test.log", input: Entry, schema: Schema.String, project: event => event.text })

const eventLog = Log.make({ schema: Event, readBatchSize: 3 })

// logViews checks typed key selections, forward and reverse pages, JSON recovery, and the atom adapter against array slices.
export const logViews = fc.property(fc.array(fc.boolean(), { maxLength: 60 }), fc.integer({ min: 1, max: 10 }), (matches, limit) => {
  const records: Recorded<typeof Event.Type>[] = matches.map((match, position) => ({ event: match ? { type: "LogEntry", text: String(position) } : { type: "LogNoise" } }))
  const source = memoryJournalReads(() => records)
  const view = eventLog.view("LogEntry")
  const reactive = durableAtom.log(view)
  const selection = Schema.decodeUnknownSync(view.Range)(JSON.parse(JSON.stringify(view.range({ from: 0, to: records.length }))))
  const read = (options: Parameters<typeof eventLog.read>[1] = {}) => Effect.runSync(eventLog.read(selection, options).pipe(Effect.provide(Log.layer(source))))
  assert.ok(read().rows.every(row => typeof row.value.text === "string"))
  const snapshot = createEventLog({ schema: Event, atoms: { empty: atom(null) } })
  try {
    for (const order of ["asc", "desc"] as const) {
      const expected = records.flatMap((record, position) => record.event.type === "LogEntry" ? [{ position, value: record.event }] : [])
      if (order === "desc") expected.reverse()
      let page = read({ limit, order })
      assert.deepEqual(snapshot.replay(records).get(reactive.range({ from: selection.from, to: selection.to, limit, order })), page)
      const actual = [...page.rows]
      records.push({ event: { type: "LogEntry", text: "future" } })
      while (page.next) {
        page = read({ after: page.next, limit })
        actual.push(...page.rows)
      }
      assert.deepEqual(actual, expected)
      records.pop()
    }
    const all = eventLog.view(["LogNoise", "LogEntry"])
    const page = Effect.runSync(eventLog.read(all.range({ from: 0, to: records.length }), { limit: records.length + 1 }).pipe(Effect.provide(Log.layer(source))))
    assert.deepEqual(page.rows.map(row => row.value), records.map(record => record.event))
    assert.throws(() => eventLog.view("Unknown" as "LogEntry"), /Unknown log event/)
    assert.throws(() => view.range({ from: 2, to: 1 }))
    assert.throws(() => Schema.decodeSync(view.Range)({ events: ["LogNoise"], from: 0, to: 0 }))
    assert.throws(() => Schema.decodeSync(LogSelection)({ events: ["LogEntry", "LogEntry"], from: 0, to: 0 }))
    assert.throws(() => read({ limit: 0 }), /page limit/)
    assert.throws(() => Effect.runSync(eventLog.read({ ...selection, to: records.length + 1 }).pipe(Effect.provide(Log.layer(source)))), /outside its source prefix/)
    if (records.length) assert.throws(() => read({ after: { ...selection, events: ["LogNoise"], order: "asc", position: 0 } }), /cursor does not belong/)
  } finally { snapshot.dispose() }
})

// logViewVersions applies the journal's declared event migrations to standalone reads.
export const logViewVersions = () => {
  const previous = Schema.Struct({ type: Schema.Literal("Renamed"), text: Schema.String })
  const current = Schema.Struct({ type: Schema.Literal("Renamed"), version: Schema.Literal(1), body: Schema.String })
  const event = versionedEvent(previous).to(current, value => ({ type: "Renamed", version: 1, body: value.text }))
  const log = Log.make({ schema: event.schema })
  const selection = log.view("Renamed").range({ from: 0, to: 1 })
  const source = memoryJournalReads(() => [{ event: { type: "Renamed", text: "old" } }])
  const page = Effect.runSync(log.read(selection).pipe(Effect.provide(Log.layer(source))))
  assert.deepEqual(page.rows, [{ position: 0, value: { type: "Renamed", version: 1, body: "old" } }])
}

// logPages compares forward and reverse cursor walks with array slices, including immutable prefixes and branch tails.
export const logPages = fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }), fc.integer({ min: 1, max: 12 }), (matches, limit) => {
  const records: Recorded<typeof Event.Type>[] = matches.map((match, position) => ({ event: match ? { type: "LogEntry", text: String(position) } : { type: "LogNoise" } }))
  const log = createEventLog({ schema: Event, atoms: { empty: atom(null) } })
  try {
    const snapshot = log.replay(records)
    const split = Math.floor(records.length / 2)
    const restored = createEventLog({ schema: Event, atoms: { empty: atom(null) }, checkpoint: log.replay(records.slice(0, split)).checkpoint()!, ...memoryJournalReads(() => records) })
    try {
      const mixed = restored.replay(records.slice(split))
      for (const order of ["asc", "desc"] as const) assert.deepEqual(mixed.get(entries.range({ order, limit: records.length })), snapshot.get(entries.range({ order, limit: records.length })))
    } finally { restored.dispose() }
    for (const order of ["asc", "desc"] as const) {
      const expected = records.flatMap((record, position) => record.event.type === "LogEntry" ? [{ position, value: String(position) }] : [])
      if (order === "desc") expected.reverse()
      let page = snapshot.get(entries.range({ order, limit }))
      const actual = [...page.rows]
      const extended = log.replay([...records, { event: { type: "LogEntry", text: "later" } }])
      while (page.next) {
        page = extended.get(entries.range({ after: page.next, limit }))
        assert.equal(page.snapshot, records.length)
        actual.push(...page.rows)
      }
      assert.deepEqual(actual, expected)
      assert.equal(extended.get(entries.range({ order: "desc", limit: 1 })).rows[0]?.value, "later")
      const subset = snapshot.get(entries.range({ from: 1, to: records.length, order, limit: records.length }))
      assert.deepEqual(subset.rows, expected.filter(row => row.position >= 1))
    }
    for (let position = 0; position < records.length; position++) assert.equal(snapshot.get(entries.row(position)), matches[position] ? String(position) : undefined)
    assert.equal(snapshot.get(entries.row(records.length)), undefined)
    assert.deepEqual(snapshot.checkpoint()!.durable, [])
    const first = snapshot.get(entries.range({ limit: 1 }))
    if (first.next) {
      assert.throws(() => snapshot.get(entries.range({ after: { ...first.next!, log: "another" } })), /cursor does not belong/)
      assert.throws(() => snapshot.get(entries.range({ after: { ...first.next!, snapshot: records.length + 1 } })), /outside its journal prefix/)
    }
  } finally { log.dispose() }
})

// logQueries rejects invalid page bounds and cursors.
export const logQueries = () => {
  assert.throws(() => entries.range({ limit: 0 }), /page limit/)
  assert.throws(() => entries.row(-1), /row position/)
  assert.throws(() => entries.range({ from: Number.NaN }), /Log bounds/)
  assert.throws(() => entries.range({ after: { log: entries.name, version: entries.indexVersion, snapshot: Infinity, from: 0, to: 1, position: 0, order: "asc" } }), /Log cursor/)
}

// logStorage checks SQL reverse seeks, checkpoint recovery, pinned pagination across appends, and bounded row decoding on both hosts.
export async function logStorage(fixture: { readonly open: () => ReturnType<typeof sqlJournal>; readonly execute: (query: string) => readonly Record<string, unknown>[] }) {
  let journal = fixture.open()
  const records: Recorded<typeof Event.Type>[] = Array.from({ length: 180 }, (_, position) => ({ event: position % 3 ? { type: "LogEntry", text: String(position) } : { type: "LogNoise" } }))
  await Effect.runPromise(journalCommit(journal, () => journal.append(0, records)))
  let projected = 0
  const indexed = durableAtom.log({ name: "test.sql-log", input: Entry, schema: Schema.String, project: event => { projected++; return event.text } })
  const memory = createEventLog({ schema: Event, atoms: { empty: atom(null) } })
  const checkpoint = memory.replay(records).checkpoint()!
  memory.dispose()
  const open = () => {
    let delivered = 0
    let largestRead = 0
    const replay = createEventLog({ schema: Event, checkpoint, atoms: { page: indexed.range({ order: "desc", limit: 7 }) },
      readRange: (from, to) => { largestRead = Math.max(largestRead, to - from); return journal.readRange(from, to) },
      readOperation: journal.readOperation,
      readFamily: function* (...args) { for (const entry of journal.readFamily(...args)) { delivered++; yield entry } },
    })
    return { replay, delivered: () => delivered, largestRead: () => largestRead }
  }
  let current = open()
  try {
    const page = current.replay.initial.view().page
    assert.deepEqual(page.rows.map(row => row.position), [179, 178, 176, 175, 173, 172, 170])
    assert.equal(current.delivered(), 8)
    assert.equal(projected, 7)
    assert.ok(current.largestRead() < records.length)
    assert.deepEqual(current.replay.initial.checkpoint()!.durable, [])
    const typed = Log.make({ schema: Event })
    const selection = typed.view("LogEntry").range({ from: 160, to: records.length })
    const typedPage = Effect.runSync(typed.read(selection, { order: "desc", limit: 7 }).pipe(Effect.provide(Log.layer(journal))))
    assert.deepEqual(typedPage.rows.map(row => row.position), page.rows.map(row => row.position))
    const mixed = typed.view(["LogEntry", "LogNoise"]).range({ from: 160, to: records.length })
    const mixedPage = Effect.runSync(typed.read(mixed, { order: "desc", limit: 7 }).pipe(Effect.provide(Log.layer(journal))))
    assert.deepEqual(mixedPage.rows.map(row => row.position), [179, 178, 177, 176, 175, 174, 173])
    const next = page.next!
    const plan = fixture.execute("EXPLAIN QUERY PLAN SELECT seq FROM experimental_journal_keys WHERE actor = 'events' AND family = '[\"log\",\"test.sql-log\"]' AND key = 'rows' AND seq >= 0 AND seq < 180 ORDER BY seq DESC LIMIT 8")
    assert.ok(plan.some(row => String(row.detail).includes("SEARCH") && String(row.detail).includes("PRIMARY KEY")))
    current.replay.dispose()
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    current = open()
    assert.deepEqual(current.replay.initial.view().page, page)
    assert.deepEqual(Effect.runSync(typed.read(selection, { order: "desc", limit: 7 }).pipe(Effect.provide(Log.layer(journal)))), typedPage)
    await Effect.runPromise(journalCommit(journal, () => journal.append(records.length, [{ event: { type: "LogEntry", text: "later" } }])))
    const continuation = createEventLog({ schema: Event, atoms: { page: indexed.range({ after: next, limit: 7 }) }, checkpoint: { ...checkpoint, position: records.length + 1 }, readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily })
    try {
      assert.equal(continuation.initial.view().page.snapshot, records.length)
      assert.deepEqual(continuation.initial.view().page.rows.map(row => row.position), [169, 167, 166, 164, 163, 161, 160])
    } finally { continuation.dispose() }
    let cursor: LogCursor | undefined
    const seen: number[] = []
    do {
      const page = current.replay.initial.get(indexed.range({ ...(cursor ? { after: cursor } : {}), limit: 13 }))
      seen.push(...page.rows.map(row => row.position))
      cursor = page.next
    } while (cursor)
    assert.deepEqual(seen, records.flatMap((record, position) => record.event.type === "LogEntry" ? [position] : []))
  } finally { current.replay.dispose(); await Effect.runPromise(journal.close) }
}
