import fc from "fast-check"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { journalPublication } from "./publication"
import { acceptedInputLifetime, coldResultScenario } from "./accepted-work"
import { journalDelivery } from "./delivery"
import { acknowledgementRetry, acknowledgementOrdering } from "./recovery"
import { agentCollectionCases, agentCollections } from "./actors"
import { migrationCases, journalMigrationProperty, eventLogCases, eventLogCompatibility } from "./migration"
import { databaseIdentity, nativeMaterialMigration } from "./database"

export type SqliteHarness = (check: (driver: SyncSqlite) => void | Promise<void>) => Promise<void>
const property = <Value>(name: string, cases: fc.Arbitrary<Value>, check: (driver: SyncSqlite, value: Value) => void | Promise<void>, bunRuns: number, workerRuns: number, examples: readonly Value[] = []) => ({
  name, bunRuns, workerRuns,
  run: (use: SqliteHarness, numRuns: number) => fc.assert(fc.asyncProperty(cases, value => use(driver => check(driver, value))), { numRuns, examples: examples.map(value => [value]), includeErrorInReport: true }),
})

export const journalProperties = [
  property("publication: a database binds one journal before its first event", fc.record({ identity: fc.string(), written: fc.boolean() }), databaseIdentity, 30, 15),
  property("publication: stale journal sessions cannot replace newer state or discard held projections", fc.string(), journalPublication, 30, 15),
  property("accepted work: inputs retain their captured version until completion commits", fc.string(), acceptedInputLifetime, 30, 15),
  property("delivery: receipts prevent repeated actor transitions through checkpoint and reopen", fc.integer({ min: -100, max: 100 }), journalDelivery, 30, 15),
  ...[false, true].flatMap(promised => [false, true].map(inline => property(`accepted work: cold results survive rollback and reopen (promise: ${promised}, inline: ${inline})`, fc.record({ suffix: fc.string(), size: fc.integer({ min: 2048, max: 16384 }), fail: fc.boolean() }), (driver, value) => coldResultScenario(driver, "x".repeat(value.size) + value.suffix, promised, value.fail, inline), 15, 10, [{ suffix: "\uFEFF界🙂", size: 4096, fail: true }, { suffix: "", size: 4096, fail: false }]))),
  property("recovery: provisioning retries restore committed alarms", fc.record({ failures: fc.integer({ min: 1, max: 4 }), repeats: fc.integer({ min: 0, max: 4 }), now: fc.integer({ min: 1, max: 1_000_000_000 }) }), acknowledgementRetry, 50, 20),
  property("recovery: acknowledgement preserves competing earlier wakes", fc.record({ early: fc.integer({ min: 1, max: 1_000_000 }), gap: fc.integer({ min: 1, max: 1_000_000 }) }), (driver, value) => acknowledgementOrdering(driver, value.early, value.gap), 50, 20),
]
export const actorProperties = [property("actors: Grove-backed agent projections match plain reducers through recovery", agentCollectionCases, agentCollections, 30, 15)]
export const migrationProperties = [
  property("migration: native materials consolidate atomically and reject ambiguous journals", fc.record({ text: fc.string(), rollback: fc.boolean(), multiple: fc.boolean(), chunked: fc.boolean() }), nativeMaterialMigration, 30, 15, [
    { text: "界", rollback: true, multiple: false, chunked: true },
    { text: "界", rollback: true, multiple: false, chunked: false },
    { text: "界", rollback: false, multiple: true, chunked: true },
  ]),
  property("migration: layouts, accepted work and shared roots survive rollback and reopen", migrationCases, journalMigrationProperty, 40, 15),
  ...(["input-digest", "input-chunk", "tree-node"] as const).map(corrupt => property(`migration: corrupt source remains intact (${corrupt})`, migrationCases, (driver, value) => journalMigrationProperty(driver, value, corrupt), 15, 5)),
  property("migration: event schemas, row bytes and receipts remain unchanged", eventLogCases, eventLogCompatibility, 30, 15),
]
