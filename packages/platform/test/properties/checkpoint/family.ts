import { strict as assert } from "node:assert"
import { Effect, Schema } from "effect"
import { atom, createEventLog, event, journalCommit, type MessageJournal } from "@clavia/tardigrade-core"
import { durableAtom } from "@clavia/tardigrade-core/experimental"

const Changed = event({ type: "FamilyChanged", id: Schema.String, amount: Schema.Int })
type Changed = typeof Changed.Type

// familyCheckpointIndexing checks key routing, indexed replay equivalence, and version isolation around shared checkpoints.
export async function familyCheckpointIndexing(fixture: {
  readonly open: () => MessageJournal<Changed> & { readonly close: Effect.Effect<void, Error> }
}) {
  const journal = fixture.open()
  let reductions = 0
  const counts = durableAtom.family({ name: "test.members", input: Changed, schema: Schema.Int, initial: 0,
    key: event => event.id === "skip" ? undefined : event.id, reduce: (state, event) => { reductions++; return state * 2 + event.amount },
  })
  const logs: { readonly dispose: () => void }[] = []
  try {
    const empty = createEventLog({ schema: Changed, atoms: { empty: atom(null) } })
    logs.push(empty)
    empty.initial.get(counts("rick"))
    const duplicate = durableAtom.family({ name: counts.name, input: Changed, schema: Schema.Int, initial: 0,
      key: event => event.id, reduce: (state, event) => state + event.amount,
    })
    assert.throws(() => empty.initial.get(duplicate("morty")), /Duplicate durable atom family name/)
    const records = [
      { event: { type: "FamilyChanged" as const, id: "rick", amount: 1 } },
      { event: { type: "FamilyChanged" as const, id: "morty", amount: 7 } },
      { event: { type: "FamilyChanged" as const, id: "skip", amount: 99 } },
      { event: { type: "FamilyChanged" as const, id: "rick", amount: 3 } },
    ]
    await Effect.runPromise(journalCommit(journal, () => journal.append(0, records)))
    const indexed = createEventLog({ schema: Changed, atoms: { empty: atom(null) }, checkpoint: { position: records.length, durable: [] },
      readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily!, readAtomCheckpoint: journal.readAtomCheckpoint!,
    })
    const scanned = createEventLog({ schema: Changed, atoms: { empty: atom(null) } })
    logs.push(indexed, scanned)
    const full = scanned.replay(records)
    assert.equal(counts("rick"), counts("rick"))
    assert.notEqual(counts("rick"), counts("morty"))
    assert.equal(indexed.initial.get(counts("rick")), 5)
    await Effect.runPromise(journalCommit(journal, () => journal.append(records.length, [], { atomCheckpoints: indexed.initial.atomCheckpoints() })))
    assert.equal(journal.readAtomCheckpoint!({ name: "morty", family: counts.name, version: counts.indexVersion }, records.length), undefined)
    for (const key of ["rick", "morty", "skip", ""]) assert.equal(indexed.initial.get(counts(key)), full.get(counts(key)))
    reductions = 0
    indexed.discard(indexed.initial)
    assert.equal(indexed.initial.get(counts("morty")), 7)
    assert.equal(reductions, 1)
    indexed.discard(indexed.initial)
    assert.equal(indexed.initial.get(counts("morty")), 7)
    assert.equal(reductions, 2)
    const first = indexed.initial.get(counts.keys({ limit: 1 }))
    assert.deepEqual(first, { keys: ["morty"], next: "morty" })
    assert.deepEqual(indexed.initial.get(counts.keys({ after: first.next, limit: 1 })), { keys: ["rick"] })
    const changedVersion = durableAtom.family({ name: counts.name, indexVersion: "2", input: Changed, schema: Schema.Int, initial: 0,
      key: event => event.id, reduce: (state, event) => state + event.amount,
    })
    assert.equal(journal.readAtomCheckpoint!({ name: "rick", family: counts.name, version: "2" }, records.length), undefined)
    const rebuilt = createEventLog({ schema: Changed, atoms: { empty: atom(null) }, checkpoint: { position: records.length, durable: [] },
      readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily!, readAtomCheckpoint: journal.readAtomCheckpoint!,
    })
    logs.push(rebuilt)
    assert.equal(rebuilt.initial.get(changedVersion("rick")), 4)
    assert.equal(full.get(counts("rick")), 5)
  } finally { for (const log of logs) log.dispose(); await Effect.runPromise(journal.close) }
}
