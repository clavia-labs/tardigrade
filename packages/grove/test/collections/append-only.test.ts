import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import fc from "fast-check"
import { appendOnly, make } from "@tardie/grove"
import { makeLegacySync as makeSync } from "../../src/storage/sqlite/store"
import { AppendState } from "./append-only"

test("append-only schemas reject generated indexed edits without staging partial batches", () => {
  fc.assert(fc.property(fc.string(), fc.nat(5), (text, index) => {
    const grove = make({ scope: "constraints", load: () => { throw new Error("Unexpected cold read") } })
    const view = grove.bind(AppendState).initial({ events: Array.from({ length: 6 }, () => ({ text, notes: [text] })), audit: [], groups: [{ entries: [text] }], ordinary: [text] })
    const before = grove.stats().stagedNodes, beforeRows = grove.stats().stagedRows
    // @ts-expect-error Existing entries of an append-only array cannot be edited.
    expect(() => view.set(["events", index, "text"], text)).toThrow("Append-only")
    // @ts-expect-error Append-only arrays cannot be spliced.
    expect(() => view.splice(["events"], 0, 1)).toThrow("Append-only")
    // @ts-expect-error Mutations cannot enter an existing append-only entry.
    expect(() => view.append(["events", index, "notes"], [text])).toThrow("Append-only")
    expect(() => view.batch(edit => {
      edit.set(["audit"], ["replacement", text])
      // @ts-expect-error Batch edits enforce the same append-only paths.
      edit.set(["events", index], { text, notes: [] })
    })).toThrow("Append-only")
    // @ts-expect-error Nested append-only arrays retain their edit constraints.
    expect(() => view.set(["groups", 0, "entries", 0], text)).toThrow("Append-only")
    // @ts-expect-error Optional fields inside existing entries cannot be removed.
    expect(() => view.remove(["events", index, "note"])).toThrow("Append-only")
    expect(grove.stats().stagedNodes).toBe(before)
    expect(grove.stats().stagedRows).toBe(beforeRows)
    expect(view.splice(["ordinary"], 0, 1, [text, text]).read(["ordinary"])).toEqual([text, text])
    expect(view.set(["events"], []).read(["events"])).toEqual([])
    expect(view.set([], { events: [], audit: [], groups: [], ordinary: [] }).length(["events"])).toBe(0)
  }))
})

test("append-only root arrays preserve ordinary JSON authoring", () => {
  fc.assert(fc.property(fc.array(fc.string()), fc.array(fc.string()), (initial, extra) => {
    const grove = make({ scope: "root", load: () => { throw new Error("Unexpected cold read") } })
    const view = grove.bind(appendOnly(Schema.Array(Schema.String))).initial(initial)
    expect(view.append([], extra).read([])).toEqual([...initial, ...extra])
    expect(view.set([], extra).read([])).toEqual(extra)
    // @ts-expect-error The append-only root cannot be spliced.
    expect(() => view.splice([], 0, 0)).toThrow("Append-only")
    // @ts-expect-error The append-only root cannot be indexed for mutation.
    expect(() => view.set([0], "changed")).toThrow("Append-only")
  }))
})

test("cold appends write only new rows and scans obey the shared cache and batch budgets", () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: 200 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 32, max: 2048 }), fc.constantFrom(0, 512, 8192), (count, rowBatchItems, textBytes, cacheBytes) => {
    const db = new Database(":memory:"), reads: unknown[][] = []
    const driver = { identity: db, execute: (sql: string, parameters: readonly (string | number | null | Uint8Array)[]) => {
      if (sql.startsWith("SELECT r.idx")) reads.push([...parameters])
      return db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters)
    }, transaction: <Value>(work: () => Value) => db.transaction(work)() }
    try {
      const config = { scope: "cold-append", cacheBytes, rowBatchItems }, schema = Schema.Struct({ entries: appendOnly(Schema.Array(Schema.Struct({ text: Schema.String }))) })
      const original = makeSync(driver, config), history = Array.from({ length: count }, (_, index) => ({ text: `historical-${index}:` + "x".repeat(textBytes) }))
      const first = original.bind(schema).initial({ entries: history })
      original.transaction(tx => original.commit(tx, { publish: [{ owner: "head", expected: null, document: first }] }))
      const cold = makeSync(driver, config), next = cold.bind(schema).open(first.reference).append(["entries"], [{ text: "new" }])
      expect(reads).toHaveLength(0)
      const result = cold.transaction(tx => cold.commit(tx, { publish: [{ owner: "head", expected: first.reference, document: next }] }))
      expect(result.rows).toBe(1)
      expect(result.nodes).toBe(2)
      expect(reads).toHaveLength(0)
      expect([...cold.view(next.reference, schema).scan(["entries"])]).toEqual([...history, { text: "new" }])
      expect(cold.bind(schema).open(next.reference).read(["entries", count, "text"])).toBe("new")
      for (const parameters of reads) expect(Number(parameters[2]) - Number(parameters[1])).toBeLessThanOrEqual(rowBatchItems)
      expect(cold.stats().cachedBytes).toBeLessThanOrEqual(cacheBytes)
      expect(cold.stats().rowBatchItems).toBe(rowBatchItems)
    } finally { db.close() }
  }), { numRuns: 50, includeErrorInReport: true })
})
