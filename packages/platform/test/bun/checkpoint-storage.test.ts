import type { Journal } from "@clavia/tardigrade-core"
import type { EffectServiceClient } from "../fixtures/effect-service"
import { bunEffectService } from "../fixtures/bun/effect-service"
import { Effect, Schema } from "effect"
import * as fc from "fast-check"
import { operationLifecycle, operationLifecycleCases, type LifecycleEvent, defaultAttemptDeadline, attemptDeadlineCases, attemptDeadlineLifecycle, streamDeadlineCases, streamDeadlineLifecycle, operationRaceCases, operationRace } from "../properties/runtime/operation-lifecycle"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { bunJournal, observeBunThread } from "../../src/bun"
import { bunThreadPath } from "../../src/bun/observe"
import { pendingInputRecovery, cancellationInputRecovery, stoppedInputRecovery, cancellationStall, cancellationRetryRecovery } from "../properties/runtime/pending-input-recovery"
import { checkpointStorage } from "../properties/checkpoint-storage"
import { lazyAtomRecovery } from "../properties/runtime/atom-checkpoint"


test("checkpointStorage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tardie-checkpoint-"))
  const coordinate = { actor: "fixture", instance: "default", thread: "storage" }
  const filename = bunThreadPath(directory, coordinate)
  mkdirSync(dirname(filename), { recursive: true })
  const db = new Database(filename, { create: true })
  try {
    await checkpointStorage({ open: checkpointChunkBytes => bunJournal({ filename, actor: "events", checkpointChunkBytes, eventInlineBytes: 1 }), execute: async query => db.query<Record<string, unknown>, []>(query).all() })
    const observer = observeBunThread({ storage: directory, coordinate, schema: Schema.Struct({ type: Schema.Literal("Stored"), value: Schema.String }) })
    try { await Effect.runPromise(observer.refresh); expect([...observer.records.get()].map(record => record.event).filter(event => event.type === "Stored")).toEqual(["first", "second", "pending", "settled"].map(value => ({ type: "Stored", value }))) }
    finally { await Effect.runPromise(observer.close) }
  }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("accepted input recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tardie-input-recovery-"))
  const fixture: Parameters<typeof cancellationInputRecovery>[0] = {
    open: (name: string) => bunJournal({ filename: join(directory, `${name}.sqlite`), actor: name, checkpointChunkBytes: 127 }),
    execute: async (name: string, query: string) => { const db = new Database(join(directory, `${name}.sqlite`)); try { return db.exec(query) } finally { db.close() } },
  }
  try { await pendingInputRecovery(fixture); await pendingInputRecovery(fixture, true); await stoppedInputRecovery(fixture); await stoppedInputRecovery(fixture, true); await cancellationInputRecovery(fixture); await cancellationInputRecovery(fixture, 3); await cancellationRetryRecovery(fixture) }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

test("lazy atom checkpoint recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tardie-lazy-checkpoint-"))
  try { await lazyAtomRecovery({ open: () => bunJournal({ filename: join(directory, "lazy.sqlite"), actor: "lazy-checkpoint" }) }) }
  finally { rmSync(directory, { recursive: true, force: true }) }
})

for (const mode of ["producer", "cleanup", "failure", "defect", "rejected"] as const) {
  test(`unresolved cancellation: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tardie-cancellation-stall-"))
    try { await cancellationStall({ open: name => bunJournal({ filename: join(directory, `${name}.sqlite`), actor: name }) }, mode) }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

async function withEffectService(work: (journal: Journal<LifecycleEvent>, service: EffectServiceClient, execute: (query: string) => Promise<unknown>) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "tardie-operation-"))
  const filename = join(directory, "actor.sqlite")
  const journal = bunJournal<LifecycleEvent>({ filename, actor: "operation", checkpointChunkBytes: 127 })
  const external = bunEffectService(join(directory, "service.sqlite"))
  const execute = async (query: string) => { const db = new Database(filename); try { db.exec(query) } finally { db.close() } }
  try { await work(journal, external.client, execute) }
  finally {
    try { await external.close() }
    finally { try { await Effect.runPromise(journal.close) } finally { rmSync(directory, { recursive: true, force: true }) } }
  }
}

test("operation lifecycle crosses recovery boundaries", () => fc.assert(fc.asyncProperty(operationLifecycleCases, scenario =>
  withEffectService((journal, service) => operationLifecycle(journal, scenario, service))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

for (const phase of ["execution", "cleanup"] as const) {
  test(`default ${phase} deadline reaches the retry decision`, () =>
    withEffectService((journal, service) => defaultAttemptDeadline(journal, service, phase)))
}

test("attempt deadlines preserve the operation lifecycle", () => fc.assert(fc.asyncProperty(attemptDeadlineCases, scenario =>
  withEffectService((journal, service) => attemptDeadlineLifecycle(journal, service, scenario))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("stream deadlines preserve the operation lifecycle", () => fc.assert(fc.asyncProperty(streamDeadlineCases, scenario =>
  withEffectService((journal, service) => streamDeadlineLifecycle(journal, service, scenario))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

for (const scenario of operationRaceCases) {
  test(`operation race ${scenario.order} (fault: ${scenario.fault})`, () =>
    withEffectService((journal, service, execute) => operationRace(journal, service, execute, scenario)))
}
