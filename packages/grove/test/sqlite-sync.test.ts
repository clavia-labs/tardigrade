import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import fc from "fast-check"
import { encodeReference, type ValueReference } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"

const Message = Schema.Struct({ text: Schema.String })
const State = Schema.Struct({ messages: Schema.Array(Message), status: Schema.String })
const optionsArb = fc.record({ chunkBytes: fc.integer({ min: 1, max: 256 }), maxParameters: fc.integer({ min: 5, max: 12 }), cacheBytes: fc.constantFrom(0, 256, 8192), pageItems: fc.integer({ min: 2, max: 8 }) })
const valueArb = fc.record({ messages: fc.array(fc.record({ text: fc.string() }), { minLength: 2, maxLength: 15 }), status: fc.string() })
const fixture = (options: { chunkBytes: number; maxParameters: number; cacheBytes: number; pageItems: number }) => {
  const db = new Database(":memory:")
  const driver: SyncSqlite = { identity: db, execute: (statement, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(statement).all(...parameters), transaction: work => db.transaction(work)() }
  const config = { ...options, scope: "documents", leafBytes: 64, tailBytes: 32 }
  return { db, driver, config, store: makeSync(driver, config) }
}

test("transaction sequences match a JSON owner model through rollback, collection and reopen", () => {
  const command = fc.record({ action: fc.constantFrom("append", "set", "rollback", "retain", "collect", "reopen"), text: fc.string(), slot: fc.nat(3) })
  fc.assert(fc.property(optionsArb, valueArb, fc.array(command, { minLength: 10, maxLength: 40 }), (options, initial, commands) => {
    const { db, driver, config, store: first } = fixture(options)
    try {
      db.exec("CREATE TABLE journal(id INTEGER PRIMARY KEY)")
      let store = first, model = structuredClone(initial), accepted = 0
      const retained = new Map<string, { reference: ValueReference; value: typeof initial }>()
      const document = store.bind(State).initial(initial)
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
      for (const command of commands) {
        const previous = store.owner("head")!
        if (command.action === "append" || command.action === "set" || command.action === "rollback") {
          const draft = command.action === "set" ? store.bind(State).open(previous).set(["status"], command.text) : store.bind(State).open(previous).append(["messages"], [{ text: command.text }])
          const next = command.action === "set" ? { ...model, status: command.text } : { ...model, messages: [...model.messages, { text: command.text }] }
          const write = () => store.transaction(tx => {
            store.commit(tx, { publish: [{ owner: "head", expected: previous, document: draft }] })
            tx.execute("INSERT INTO journal VALUES(?)", [accepted])
            if (command.action === "rollback") throw new Error("Injected rollback")
          })
          if (command.action === "rollback") {
            expect(write).toThrow("Injected rollback")
            expect(encodeReference(store.owner("head")!)).toBe(encodeReference(previous))
            expect(store.stats().stagedNodes).toBeGreaterThan(0)
          } else { write(); model = next; accepted++ }
          store.discard()
        } else if (command.action === "retain") {
          const name = `input/${command.slot}`, old = retained.get(name)
          if (old) { store.transaction(tx => store.commit(tx, { release: [{ owner: name, expected: old.reference }] })); retained.delete(name) }
          else { store.transaction(tx => store.commit(tx, { retain: [{ owner: name, selection: previous }] })); retained.set(name, { reference: previous, value: structuredClone(model) }) }
        } else if (command.action === "collect") store.collect()
        else store = makeSync(driver, config)
        expect(store.view(store.owner("head")!, State).materialize()).toEqual(model)
        for (const [name, retainedValue] of retained) {
          expect(encodeReference(store.owner(name)!)).toBe(encodeReference(retainedValue.reference))
          expect(store.view(retainedValue.reference, State).materialize()).toEqual(retainedValue.value)
        }
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM journal").get()!.n).toBe(accepted)
        expect(store.stats().cachedBytes).toBeLessThanOrEqual(options.cacheBytes)
      }
      const head = store.owner("head")!
      store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: head }, ...[...retained].map(([owner, entry]) => ({ owner, expected: entry.reference }))] }))
      store.discard(); store.collect()
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_value_nodes").get()!.n).toBe(0)
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
}, 30000)
