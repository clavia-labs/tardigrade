import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import fc from "fast-check"
import { make, tree, appendOnly, keyValue, collectionSchema } from "@tardie/grove"
import { makeSync } from "@tardie/grove/sqlite"

const Job = Schema.Struct({ text: Schema.String, items: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) })
const State = Schema.Struct({ document: tree(Schema.Struct({ count: Schema.Int })), messages: appendOnly(Schema.Array(Schema.String)), jobs: keyValue(Job) })
const cases = fc.array(fc.record({ key: fc.constantFrom("a", "b", "__proto__", "constructor"), text: fc.string(), remove: fc.boolean() }), { minLength: 5, maxLength: 30 })

test("collection declarations match JSON through native commits, retained versions and collection", () => {
  fc.assert(fc.property(cases, fc.constantFrom(0, 128, 8192), (edits, cacheBytes) => {
    const db = new Database(":memory:"), driver = { identity: db, execute: (sql: string, parameters: readonly (string | number | null | Uint8Array)[]) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: <Value>(work: () => Value) => db.transaction(work)() }
    try {
      const config = { scope: "collections", cacheBytes, objectPageItems: 2, fanout: 2, leafBytes: 64, tailBytes: 32 }
      let store = makeSync(driver, config), model: typeof State.Type = { document: { count: 0 }, messages: [], jobs: {} }, document = store.bind(State).initial(model)
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
      const first = document.reference
      store.transaction(tx => store.commit(tx, { retain: [{ owner: "first", selection: first }] }))
      for (const [count, edit] of edits.entries()) {
        const expected = document.reference
        document = document.batch(state => {
          state.set(["document", "count"], count + 1)
          state.append(["messages"], [edit.text])
          if (edit.remove) state.remove(["jobs", edit.key])
          else state.set(["jobs", edit.key], { text: edit.text, items: [edit.text] })
        })
        const jobs = { ...model.jobs }
        if (edit.remove) delete jobs[edit.key]; else Object.defineProperty(jobs, edit.key, { value: { text: edit.text, items: [edit.text] }, enumerable: true, configurable: true, writable: true })
        model = { document: { count: count + 1 }, messages: [...model.messages, edit.text], jobs }
        store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected, document }] }))
        store = makeSync(driver, config); store.collect()
        document = store.bind(State).open(store.owner("head")!)
        expect(document.read([])).toEqual(model)
        expect(store.view(first, State).materialize()).toEqual({ document: { count: 0 }, messages: [], jobs: {} })
      }
    } finally { db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})

test("collection vocabularies reject generated edits inside key-value entries", () => {
  fc.assert(fc.property(fc.string(), text => {
    const grove = make({ scope: "constraints", load: () => { throw new Error("Unexpected read") } })
    const document = grove.bind(State).initial({ document: { count: 0 }, messages: [], jobs: { job: { text, items: [text] } } })
    // @ts-expect-error Key-value entries require whole-value replacement.
    expect(() => document.set(["jobs", "job", "text"], text)).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject nested append operations.
    expect(() => document.append(["jobs", "job", "items"], [text])).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject nested array splices.
    expect(() => document.splice(["jobs", "job", "items"], 0, 1)).toThrow("whole-entry")
    // @ts-expect-error Key-value entries reject removal of nested optional fields.
    expect(() => document.remove(["jobs", "job", "note"])).toThrow("whole-entry")
    expect(document.set(["jobs", "job"], { text, items: [] }).read(["jobs", "job"])).toEqual({ text, items: [] })
    expect(document.remove(["jobs", "job"]).read(["jobs"])).toEqual({})
    expect(collectionSchema(State.ast)).toBe(true)
    expect(() => collectionSchema(Schema.suspend(() => State).ast)).toThrow("explicit tree")
    expect(() => collectionSchema(Schema.Union([State, Schema.Struct({ value: tree(Schema.String) })]).ast)).toThrow("explicit tree")
    expect(collectionSchema(tree(Schema.Int).annotate({ title: text }).ast)).toBe(true)
    expect(() => collectionSchema(Schema.Struct({ declared: tree(Schema.Int), undeclared: Schema.String }).ast)).toThrow("Each durable state field")
  }), { includeErrorInReport: true })
})

test("key-value replacement writes one SQL revision without loading previous payloads or a Merkle key index", () => {
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
