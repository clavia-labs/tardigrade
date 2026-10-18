import { evictDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { expect, test } from "vitest"
import { waitFor, testStage } from "../fixtures/wait"
import type { MigrationDO } from "../fixtures/workerd/migration.worker"
import fixture from "../fixtures/migration/050-snapshot.json"

// reset discards the actor instance while retaining its native DO storage.
async function reset(stub: DurableObjectStub<MigrationDO>) {
  try { await stub.abort() } catch (cause) { expect(String(cause)).toContain("Migration fixture reset") }
}

test("0.50 actor upgrades in place, rolls back failed cleanup, resumes its accepted effect and collects obsolete materials", async () => {
  const namespace = (env as unknown as { MIGRATION: DurableObjectNamespace<MigrationDO> }).MIGRATION
  let stub = namespace.getByName("050-full-migration")
  const source = await testStage("seed actual 0.50 snapshot", () => stub.seed(), 20_000)
  expect(fixture.source).toBe("d0191382c92c63d820a9e07c7e95b4d4ecbc0094")
  expect(source.materials).toMatchObject({ checkpoint_trees: 1, effect_inputs: 1 })
  expect(source.chunks.length).toBeGreaterThan(1)
  expect(source.receipts).toEqual([{ actor: "events", id: "migration-message", seq: 0 }])
  expect(source.nativeOwners).toEqual([])
  expect(fixture.records.find(record => record.event.type === "EffectRequested")?.event.request?.input).toMatchObject({ _tag: "InputDigest", bytes: expect.any(Number) })
  const recovery = await stub.inspectRecovery()
  expect(recovery.legacy).toHaveLength(3)
  expect(recovery.alarm).toBe(fixture.recovery.dueAt)
  await testStage("inject cleanup transaction failure", () => stub.failCleanup())
  await evictDurableObject(stub)
  stub = namespace.getByName("050-full-migration")
  const failed = await testStage("upgrade with failed cleanup", () => stub.attemptUpgrade())
  expect(await stub.inspectSource()).toEqual(source)
  expect(await stub.inspectRecovery()).toEqual(recovery)
  expect(failed.error).toContain("migration cleanup fault")
  await testStage("release cleanup fault", () => stub.allowCleanup())
  await reset(stub)
  stub = namespace.getByName("050-full-migration")
  const upgraded = await testStage("upgrade after cold restart", () => waitFor(() => stub.inspect(), value => value.calls.length === 1))
  expect(upgraded.view).toEqual(fixture.view)
  expect(upgraded.recovery.legacy).toEqual([])
  expect(upgraded.recovery.alarm).toBe(recovery.alarm)
  expect(upgraded.recovery.wakes).toEqual([{ id: fixture.recovery.wake.id, entry: JSON.stringify(fixture.recovery.wake) }])
  expect(upgraded.recovery.watchdog).toEqual([{ id: fixture.recovery.key, entry: JSON.stringify(fixture.recovery.watchdog) }])
  expect(upgraded.recovery.generation).toEqual([{ id: 1, value: fixture.recovery.generation }])
  expect(upgraded.inputs).toHaveLength(1)
  expect(upgraded.inputs[0]!.ref).toEqual(fixture.ref)
  expect(upgraded.calls[0]!.input).toEqual(fixture.acceptedInput)
  expect(upgraded.job).toMatchObject({ executions: 1, submissions: 2 })
  expect(upgraded.source.digest).toBe(source.digest)
  expect(upgraded.source.schema).toEqual(source.schema)
  expect(upgraded.source.materials).toEqual(Object.fromEntries(Object.keys(source.materials).map(table => [table, 0])))
  expect(upgraded.source.nativeOwners.length).toBeGreaterThan(0)
  await reset(stub)
  stub = namespace.getByName("050-full-migration")
  const resumed = await testStage("resume migrated pending input", () => waitFor(() => stub.inspect(), value => value.calls.length === 2))
  expect(resumed.instance).not.toBe(upgraded.instance)
  expect(resumed.calls.every(call => JSON.stringify(call.ref) === JSON.stringify(fixture.ref) && JSON.stringify(call.input) === JSON.stringify(fixture.acceptedInput))).toBe(true)
  expect(resumed.job).toMatchObject({ executions: 1, submissions: 3 })
  expect(resumed.source.digest).toBe(source.digest)
  const completed = await testStage("settle accepted work and checkpoint", () => stub.finish())
  expect(completed.view).toEqual({ ...fixture.view, done: true })
  expect(completed.inputs).toEqual([])
  expect(completed.job).toMatchObject({ executions: 1, status: "completed", outputs: [fixture.acceptedInput] })
  expect(completed.source.events.slice(0, source.events.length)).toEqual(source.events)
  expect(completed.source.chunks.slice(0, source.chunks.length)).toEqual(source.chunks)
  expect(completed.source.receipts).toEqual(source.receipts)
  expect(completed.source.nativeOwners.some(owner => String(owner.name).includes('"input"'))).toBe(false)
  await reset(stub)
  stub = namespace.getByName("050-full-migration")
  const settled = await testStage("restart completed migration", () => stub.inspect())
  expect(settled.instance).not.toBe(completed.instance)
  expect(settled.view).toEqual(completed.view)
  expect(settled.inputs).toEqual([])
  expect(settled.calls).toEqual(completed.calls)
  expect(settled.source).toEqual(completed.source)
}, 60000)
