import { test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import { makeSync, type Row, type Json } from "../../src/reducer"
import { actions, runHistory } from "./oracle"

const event = fc.record({ type: fc.constantFrom(...actions), from: fc.nat({ max: 100 }), to: fc.nat({ max: 100 }), value: fc.jsonValue().map(value => JSON.parse(JSON.stringify(value)) as Json) })
const instruction = fc.record({ event, observe: fc.boolean(), publish: fc.boolean(), restart: fc.boolean(), rollback: fc.boolean(), collect: fc.boolean(), release: fc.boolean() })

test("plain-reducer oracle survives moves, duplicates, aliases, clones, replay and recovery", () => {
  fc.assert(fc.property(fc.array(instruction, { minLength: 1, maxLength: 80 }), fc.constantFrom(0, 64, 4096), (history, packBytes) => {
    const db = new Database(":memory:")
    try {
      runHistory(() => makeSync({ identity: db, execute: (sql, parameters) => db.query<Row, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() }, { scope: "oracle", packBytes }), history)
    } finally { db.close() }
  }), { numRuns: 300, seed: 20261020, includeErrorInReport: true })
})
