import { strict as assert } from "node:assert"
import { Effect, Schema } from "effect"
import * as fc from "fast-check"
import { atom, createEventLog, journalCommit, type Recorded } from "@clavia/tardigrade-core"
import { durableAtom, LogRef, type LogCursor } from "@clavia/tardigrade-core/experimental"
import { memoryJournalReads } from "../fixtures/memory-journal"
import type { sqlJournal } from "../../src/shared/sql-journal"

const Entry = Schema.Struct({ type: Schema.Literal("LogEntry"), text: Schema.String })
const Noise = Schema.Struct({ type: Schema.Literal("LogNoise") })
const Event = Schema.Union([Entry, Noise])
const entries = durableAtom.log({ name: "test.log", input: Entry, schema: Schema.String, project: event => event.text })

// logPages compares forward and reverse cursor walks with array slices, including immutable prefixes and branch tails.
export const logPages = fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 60 }), fc.integer({ min: 1, max: 12 }), (matches, limit) => {
  const records: Recorded<typeof Event.Type>[] = matches.map((match, position) => ({ event: match ? { type: "LogEntry", text: String(position) } : { type: "LogNoise" } }))
  const log = createEventLog({ schema: Event, atoms: { empty: atom(null) } })
  try {
    const snapshot = log.replay(records)
    const ref = Schema.decodeUnknownSync(LogRef)(JSON.parse(JSON.stringify(entries.ref({ from: 0, to: snapshot.position }))))
    const pinned = snapshot.get(entries.range({ ref, limit }))
    const later = log.append(snapshot, { type: "LogEntry", text: "future" })
    assert.deepEqual(later.get(entries.range({ ref, limit })), pinned)
    const split = Math.floor(records.length / 2)
    const restored = createEventLog({ schema: Event, atoms: { empty: atom(null) }, checkpoint: log.replay(records.slice(0, split)).checkpoint()!, ...memoryJournalReads(() => records) })
    try {
      const mixed = restored.replay(records.slice(split))
      for (const order of ["asc", "desc"] as const) assert.deepEqual(mixed.get(entries.range({ order, limit: records.length })), snapshot.get(entries.range({ order, limit: records.length })))
    } finally { restored.dispose() }
    for (const order of ["asc", "desc"] as const) {
      const expected = records.flatMap((record, position) => record.event.type === "LogEntry" ? [{ position, value: String(position) }] : [])
      if (order === "desc") expected.reverse()
      let page = snapshot.get(entries.range({ ref, order, limit }))
      const actual = [...page.rows]
      const extended = log.replay([...records, { event: { type: "LogEntry", text: "later" } }])
      while (page.next) {
        page = extended.get(entries.range({ ref, after: page.next, limit }))
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
  assert.throws(() => entries.ref({ from: 2, to: 1 }), /reference/)
  assert.throws(() => entries.ref({ from: -1, to: 1 }), /reference/)
  const ref = entries.ref({ from: 0, to: 2 })
  assert.throws(() => entries.range({ ref: { ...ref, log: "another" } }), /reference/)
  assert.throws(() => entries.range({ ref: { ...ref, version: "another" } }), /reference/)
  assert.throws(() => entries.range({ ref, to: 3 }), /reference/)
  assert.throws(() => entries.range({ ref, after: { ...ref, snapshot: 3, position: 0, order: "asc" } }), /reference/)
  assert.throws(() => Schema.decodeSync(LogRef)({ ...ref, to: Infinity }))
  assert.throws(() => Schema.decodeSync(LogRef)({ ...ref, from: 3 }))
  const log = createEventLog({ schema: Event, atoms: { empty: atom(null) } })
  try {
    assert.deepEqual(log.initial.get(entries.range({ ref: entries.ref({ from: 0, to: 0 }) })).rows, [])
    assert.throws(() => log.initial.get(entries.range({ ref })), /outside its journal prefix/)
  }
  finally { log.dispose() }
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
    const next = page.next!
    const ref = Schema.decodeUnknownSync(LogRef)(JSON.parse(JSON.stringify(indexed.ref({ from: 160, to: records.length }))))
    const pinned = current.replay.initial.get(indexed.range({ ref, order: "desc", limit: 7 }))
    const plan = fixture.execute("EXPLAIN QUERY PLAN SELECT seq FROM experimental_journal_keys WHERE actor = 'events' AND family = '[\"log\",\"test.sql-log\"]' AND key = 'rows' AND seq >= 0 AND seq < 180 ORDER BY seq DESC LIMIT 8")
    assert.ok(plan.some(row => String(row.detail).includes("SEARCH") && String(row.detail).includes("PRIMARY KEY")))
    current.replay.dispose()
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    current = open()
    assert.deepEqual(current.replay.initial.view().page, page)
    assert.deepEqual(current.replay.initial.get(indexed.range({ ref, order: "desc", limit: 7 })), pinned)
    await Effect.runPromise(journalCommit(journal, () => journal.append(records.length, [{ event: { type: "LogEntry", text: "later" } }])))
    const continuation = createEventLog({ schema: Event, atoms: { page: indexed.range({ after: next, limit: 7 }) }, checkpoint: { ...checkpoint, position: records.length + 1 }, readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily })
    try {
      assert.deepEqual(continuation.initial.get(indexed.range({ ref, order: "desc", limit: 7 })), pinned)
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
