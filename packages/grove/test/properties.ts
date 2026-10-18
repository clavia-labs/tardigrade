import fc from "fast-check"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { appendCases, appendOnlyScenario, rowCases, rowLogScenario, rowCorruptionScenario } from "./collections/append-only"
import { keyValueCases, keyValueHistory, keyValueLifetimes, keyValueChurn, keyValueReplay, keyValueCorruption, keyValueForkChurn } from "./collections/key-value"
import { collectionShapes, historyCases, materialisationHistory } from "./collections/history"

export type SqliteHarness = (check: (driver: SyncSqlite) => void) => void | Promise<void>
const property = <Value>(name: string, cases: fc.Arbitrary<Value>, check: (driver: SyncSqlite, value: Value) => void, bunRuns: number, workerRuns: number) => ({
  name, bunRuns, workerRuns,
  run: (use: SqliteHarness, numRuns: number) => fc.assert(fc.asyncProperty(cases, async value => { await use(driver => check(driver, value)) }), { numRuns, includeErrorInReport: true }),
})
const corruption = fc.record({ text: fc.string(), chunkBytes: fc.integer({ min: 1, max: 12 }), mode: fc.constantFrom("row" as const, "chunk" as const, "length" as const) })

export const storageProperties = [
  ...collectionShapes.map(shape => property(`${shape}: immutable log prefixes materialise and resume without losing retained versions`, historyCases, (driver, value) => materialisationHistory(driver, shape, value), 50, 20)),
  property("append-only: native histories match immutable JSON versions", appendCases, appendOnlyScenario, 60, 20),
  property("append-only: draft dependencies and replay identity survive prefix reuse", rowCases, rowLogScenario, 60, 20),
  property("append-only: missing entries, broken chunks and wrong lengths are rejected", corruption, (driver, value) => rowCorruptionScenario(driver, value.text, value.chunkBytes, value.mode), 60, 20),
  property("key-value: histories match retained JSON versions through forks, rollback and collection", keyValueCases, keyValueHistory, 70, 20),
  property("key-value: held drafts survive acknowledgement, collection and rollback", fc.record({ text: fc.string(), cacheBytes: fc.constantFrom(0, 128, 8192), chunkBytes: fc.constantFrom(1, 3, 4096) }), (driver, value) => keyValueLifetimes(driver, value.text, value.cacheBytes, value.chunkBytes), 50, 20),
  property("key-value: cleanup bounds overwritten values and deleted-key churn", fc.record({ count: fc.integer({ min: 2, max: 40 }), text: fc.string() }), (driver, value) => keyValueChurn(driver, value.count, value.text), 40, 15),
  property("key-value: replay identity survives physical fork placement and collection", fc.string(), keyValueReplay, 40, 20),
  property("key-value: missing rows, incomplete chunks and corrupt lengths are rejected", corruption, (driver, value) => keyValueCorruption(driver, value.text, value.chunkBytes, value.mode), 50, 20),
  property("key-value: fork cleanup removes transient tombstones and preserves inherited deletions", fc.record({ count: fc.integer({ min: 2, max: 20 }), text: fc.string() }), (driver, value) => keyValueForkChurn(driver, value.count, value.text), 40, 15),
]
