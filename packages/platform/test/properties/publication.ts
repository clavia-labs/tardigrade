import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

// journalPublication checks journal head conflicts and projection retention across competing sessions (integration.ts).
export async function journalPublication(driver: SyncSqlite, text: string) {
  const State = Schema.Struct({ messages: Schema.Array(Schema.Struct({ text: Schema.String })) })
  const journal = synchronousJournal<{ type: string }>({ actor: "holders", driver })
  let stale: typeof journal | undefined
  const holder = {}
  try {
    const bound = journal.storedValues.bind(State), first = bound.initial({ messages: [{ text: "A:" + text }] })
    const initial = encodeReference(first.reference)
    await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: initial }] } }))
    stale = synchronousJournal({ actor: "holders", driver })
    journal.storedValues.hold(holder, "frame", initial)
    const next = first.set(["messages", 0, "text"], "B:" + text)
    await Effect.runPromise(journal.append(0, [], { documents: { references: [{ name: "history", reference: encodeReference(next.reference) }] } }))
    const obsolete = stale.storedValues.bind(State).open(initial).set(["messages", 0, "text"], "C:" + text)
    await assert.rejects(Effect.runPromise(stale.append(0, [{ event: { type: "Stale" } }], { documents: { references: [{ name: "history", reference: encodeReference(obsolete.reference) }] } })), /changed/)
    assert.deepEqual(await Effect.runPromise(journal.read), [])
    await Effect.runPromise(journal.collect)
    assert.deepEqual(journal.storedValues.read(initial), { messages: [{ text: "A:" + text }] })
    journal.storedValues.release(holder)
    await Effect.runPromise(journal.collect)
    assert.throws(() => journal.grove.view(decodeReference(initial), State).materialize())
  } finally {
    journal.storedValues.release(holder)
    if (stale) await Effect.runPromise(stale.close)
    await Effect.runPromise(journal.close)
  }
}
