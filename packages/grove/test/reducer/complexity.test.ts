import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { makeSync, type Row } from "../../src/reducer"

test("array discovery scales linearly while append, prepend, insert, edit, move and delete writes stay bounded", () => {
  for (const length of [10, 100, 1000, 10000]) {
    const db = new Database(":memory:")
    try {
      const grove = makeSync({ identity: db, execute: (sql, parameters) => db.query<Row, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }, { scope: "complexity" })
      const Item = Schema.Struct({ text: Schema.String }), State = Schema.Array(Item)
      const state = grove.materialize({ name: "items", schema: State, input: State, initial: Array.from({ length }, (_, i) => ({ text: `${i}:` + "x".repeat(1024) })), reduce: (_, value) => value })
      let current = state.initial()
      grove.transaction(tx => state.publish(tx, current, { expected: null })); grove.discard()
      const apply = (value: typeof State.Type, sequence: number, maxWrites: number) => {
        const before = grove.stats(), next = state.apply(current, { sequence, event: value, metadata: null })
        grove.transaction(tx => state.publish(tx, next, { expected: current.reference })); grove.discard()
        const after = grove.stats()
        expect(after.arrayEntriesVisited - before.arrayEntriesVisited).toBeLessThanOrEqual(7 * (Math.max(current.value.length, value.length) + 1))
        expect(after.cellWrites - before.cellWrites).toBeLessThanOrEqual(maxWrites)
        expect(after.sqlStatements - before.sqlStatements).toBeLessThanOrEqual(20)
        expect(after.encodedBytes - before.encodedBytes).toBeLessThan(2048)
        current = next
      }
      apply([...current.value, { text: "appended" }], 1, 4)
      apply([{ text: "new" }, ...current.value], 2, 3)
      const middle = Math.floor(current.value.length / 2)
      apply([...current.value.slice(0, middle), { text: "inserted" }, ...current.value.slice(middle)], 3, 4)
      apply(current.value.map((item, i) => i === middle ? { text: "edited" } : item), 4, 1)
      apply([...current.value.slice(1), current.value[0]!], 5, 3)
      apply(current.value.slice(0, -1), 6, 4)
      apply(current.value.slice(0, -1), 7, 4)
      apply(current.value.slice(0, -1), 8, 4)
      expect(current.value).toHaveLength(length)
    } finally { db.close() }
  }
})
