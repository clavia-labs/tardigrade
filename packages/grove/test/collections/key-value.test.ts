import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import fc from "fast-check"
import { keyValue } from "@tardie/grove"
import { makeLegacySync as makeSync } from "../../src/storage/sqlite/store"

const Job = Schema.Struct({ text: Schema.String, items: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) })

test("legacy key-value replacement writes one SQL revision without loading previous payloads or a Merkle key index", () => {
  fc.assert(fc.property(fc.integer({ min: 20, max: 1000 }), fc.string(), (count, text) => {
    const db = new Database(":memory:"), reads: string[] = []
    const driver = { identity: db, execute: (sql: string, parameters: readonly (string | number | null | Uint8Array)[]) => {
      if (sql.startsWith("SELECT r.key,r.revision,r.metadata,r.payload")) reads.push(sql)
      return db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters)
    }, transaction: <Value>(work: () => Value) => db.transaction(work)() }
    try {
      const schema = keyValue(Job), config = { scope: "revisions", cacheBytes: 0 }, original = makeSync(driver, config)
      const value = { text, items: Array.from({ length: count }, (_, index) => String(index)) }, first = original.bind(schema).initial({ a: value, b: value })
      original.transaction(tx => original.commit(tx, { publish: [{ owner: "head", expected: null, document: first }] }))
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM grove_value_nodes").get()!.count).toBe(1)
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) count FROM grove_map_rows").get()!.count).toBe(2)
      const cold = makeSync(driver, config), updated = cold.bind(schema).open(first.reference).set(["a"], { text: "updated", items: [] })
      const result = cold.transaction(tx => cold.commit(tx, { publish: [{ owner: "head", expected: first.reference, document: updated }] }))
      expect(result.nodes).toBe(1)
      expect(result.rows).toBe(1)
      expect(reads).toHaveLength(0)
      expect(updated.read(["a", "text"])).toBe("updated")
    } finally { db.close() }
  }), { numRuns: 40 })
})
