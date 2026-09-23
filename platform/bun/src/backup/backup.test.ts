import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, writeFileSync } from "node:fs"
import * as fs from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schedule } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { defineActor } from "@clavia/tardigrade-core/actor"
import { RemoteBackup, RemoteBackupError, captureHostCheckpoint, remoteBackupFromKeyValueStore, restoreHostCheckpoint, type HostCheckpoint } from "./index"
import { bunBackupRunner } from "./runner"
import { createBunHost, hostBackend } from "../create-host"

const actor = defineActor("backup-test", {}, [])
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return
    await pause(10)
  }
  throw new Error("backup did not reach the expected state")
}

test("local commits continue through backup failure and recovery uses the last complete checkpoint", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tardigrade-backup-"))
  const storage = join(parent, "local")
  const restored = join(parent, "restored")
  let latest: HostCheckpoint | undefined
  let fail = false
  const layer = Layer.succeed(RemoteBackup, RemoteBackup.of({
    save: (checkpoint) => fail
      ? Effect.fail(new RemoteBackupError({ message: "remote unavailable" }))
      : Effect.sync(() => { latest = checkpoint }),
    latest: Effect.sync(() => latest?.id),
    load: (id) => Effect.sync(() => latest?.id === id ? latest : undefined)
  }))
  const host = await createBunHost({
    actor,
    storage,
    backup: { layer, schedule: Schedule.spaced("10 millis"), retry: Schedule.spaced("10 millis") }
  })
  try {
    await host.allocateRootThread({ instance: "one", name: "main" })
    const instance = await hostBackend(host).ensure("one")
    await instance.commitRoot(instance.self("main"), { type: "MessageReceived", id: "first", at: 1 })
    await waitFor(() => host.backup?.status().lastCompleted !== undefined && !host.backup.status().dirty)
    const beforeFile = latest?.id
    await writeFile(join(storage, "host-state.txt"), "local state")
    await waitFor(() => latest?.id !== beforeFile)
    const saved = latest?.id
    fail = true
    await instance.commitRoot(instance.self("main"), { type: "MessageReceived", id: "second", at: 2 })
    await waitFor(() => host.backup?.status().lastError === "remote unavailable")
    expect(host.backup?.status().dirty).toBe(true)
    expect(latest?.id).toBe(saved)
  } finally {
    await host.close()
  }
  try {
    await rm(storage, { recursive: true, force: true })
    await restoreHostCheckpoint({ actor: actor.name, storage: restored, backup: layer })
    expect(await readFile(join(restored, "host-state.txt"), "utf8")).toBe("local state")
    const recovered = await createBunHost({ actor, storage: restored })
    try {
      const events = await (await hostBackend(recovered).ensure("one")).read("main")
      expect(events.some((event) => event.type === "MessageReceived" && event.id === "first")).toBe(true)
      expect(events.some((event) => event.type === "MessageReceived" && event.id === "second")).toBe(false)
    } finally {
      await recovered.close()
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("a key value backup advertises a checkpoint after storing it", async () => {
  const program = Effect.gen(function*() {
    const backup = yield* RemoteBackup
    const checkpoint: HostCheckpoint = {
      id: "test", actor: actor.name, createdAt: 1, digest: "digest", payload: new Uint8Array([1, 2, 3])
    }
    yield* backup.save(checkpoint)
    expect(yield* backup.latest).toBe("test")
    expect(yield* backup.load("test")).toEqual(checkpoint)
  })
  await Effect.runPromise(Effect.provide(program, remoteBackupFromKeyValueStore("test").pipe(Layer.provide(KeyValueStore.layerMemory))))
})

test("checkpoint size is configurable and an existing restore destination is preserved", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tardigrade-backup-policy-"))
  try {
    expect(() => captureHostCheckpoint({ actor: actor.name, storage: parent, policy: { maxBytes: 1 } })).toThrow("maxBytes")
    const checkpoint = captureHostCheckpoint({ actor: actor.name, storage: parent })
    const layer = Layer.succeed(RemoteBackup, RemoteBackup.of({
      save: () => Effect.void,
      latest: Effect.succeed(checkpoint.id),
      load: () => Effect.succeed(checkpoint)
    }))
    await expect(restoreHostCheckpoint({ actor: actor.name, storage: parent, backup: layer })).rejects.toThrow("already exists")
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("restore rejects a damaged checkpoint before creating its destination", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tardigrade-backup-integrity-"))
  const storage = join(parent, "restored")
  try {
    const checkpoint = captureHostCheckpoint({ actor: actor.name, storage: parent })
    const layer = Layer.succeed(RemoteBackup, RemoteBackup.of({
      save: () => Effect.void,
      latest: Effect.succeed(checkpoint.id),
      load: () => Effect.succeed({ ...checkpoint, digest: "damaged" })
    }))
    await expect(restoreHostCheckpoint({ actor: actor.name, storage, backup: layer })).rejects.toThrow("digest mismatch")
    expect(existsSync(storage)).toBe(false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})


test("capture rejects commits and file changes that overlap the snapshot", async () => {
  const storage = await mkdtemp(join(tmpdir(), "checkpoint-overlap-"))
  const database = new Database(join(storage, "state.sqlite"))
  database.run("PRAGMA journal_mode = WAL")
  database.run("CREATE TABLE state (value TEXT)")
  await writeFile(join(storage, "notes.txt"), "before")
  const original = Database.prototype.query
  let mutate: () => void = () => database.run("INSERT INTO state VALUES ('changed')")
  const query = spyOn(Database.prototype, "query").mockImplementation(function(this: Database, sql: string) {
    if (sql === "VACUUM INTO ?") mutate()
    return original.call(this, sql)
  } as typeof original)
  try {
    expect(() => captureHostCheckpoint({ actor: "test", storage })).toThrow("storage changed")
    mutate = () => writeFileSync(join(storage, "notes.txt"), "after")
    expect(() => captureHostCheckpoint({ actor: "test", storage })).toThrow("storage changed")
  } finally {
    query.mockRestore()
    database.close()
    await rm(storage, { recursive: true, force: true })
  }
})


test("backup layer acquisition failures are visible and retried", async () => {
  const storage = await mkdtemp(join(tmpdir(), "backup-layer-retry-"))
  let available = false
  const layer = Layer.effect(RemoteBackup, Effect.suspend(() => available
    ? Effect.succeed(RemoteBackup.of({ save: () => Effect.void, latest: Effect.succeed("test"), load: () => Effect.fail(new RemoteBackupError({ message: "no checkpoint" })) }))
    : Effect.fail(new RemoteBackupError({ message: "remote unavailable" }))))
  const runner = bunBackupRunner({ actor: "test", storage, backup: { layer, retry: Schedule.spaced("10 millis") } })
  try {
    runner.markDirty()
    runner.start()
    await waitFor(() => runner.status().lastError !== undefined)
    expect(runner.status().dirty).toBe(true)
    available = true
    await waitFor(() => runner.status().lastCompleted !== undefined)
    expect(runner.status().dirty).toBe(false)
  } finally {
    await runner.close()
    await rm(storage, { recursive: true, force: true })
  }
})


test("capture rejects oversized files before reading them into memory", async () => {
  const storage = await mkdtemp(join(tmpdir(), "checkpoint-size-"))
  await writeFile(join(storage, "large.txt"), "too large")
  const read = spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("read before size check") })
  try {
    expect(() => captureHostCheckpoint({ actor: "test", storage, policy: { maxBytes: 1 } })).toThrow("checkpoint exceeds maxBytes 1")
    expect(read).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    await rm(storage, { recursive: true, force: true })
  }
})
