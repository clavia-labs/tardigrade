import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, effectAtom, event, RuntimeError, type InitialState } from "../../../core/src/index"
import { createBunHost } from "../../src/bun"
import { bunSupervisorPath, bunThreadPath } from "../../src/bun/observe"

const Read = event({ type: "Read" })
const mode = durableAtom({ name: "fixture.mode", input: Schema.Never, schema: Schema.NullOr(Schema.String), initial: null, reduce: state => state })
const value = durableAtom({ name: "fixture.value", input: Schema.Never, schema: Schema.Finite, initial: 0, reduce: state => state })
const actor = defineActor("fixture", Effect.succeed({
  atom: effectAtom(get => ({ view: { mode: get(mode), value: get(value) }, events: {}, acts: {} })),
  methods: { read: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.NullOr(Schema.String), onReceive: Read.from(() => ({})), result: (_, get) => ({ status: "completed", output: get(mode) }) }) },
}))
const open = (storage: string, initialStateDefaults?: InitialState, fail = false, initialStateInheritedKeys?: Readonly<Record<string, Schema.Json>>) => Effect.runPromise(createBunHost({
  actor, storage, actorContext: Context.pick(), initialStateAtoms: [mode, value], ...(initialStateDefaults === undefined ? {} : { initialStateDefaults }),
  ...(initialStateInheritedKeys === undefined ? {} : { initialStateInheritedKeys }),
  checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, provisionRetry: { decide: () => Effect.void.pipe(Effect.as(undefined)) },
  services: () => fail ? Layer.effectDiscard(Effect.fail(new RuntimeError("Provision unavailable"))) : Layer.empty,
}))

test("selected child seeds preserve absence, null, explicit overrides and recorded ancestry across reopen", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-inherited-seeds-"))
  const keys = { "fixture.mode": null }
  let host = await open(storage, undefined, false, keys)
  try {
    const legacy = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "legacy" }))
    const legacyChild = await Effect.runPromise(host.allocateChildThread({ parent: legacy.coordinate, name: "child" }))
    for (const thread of [legacy, legacyChild]) expect((await Effect.runPromise(thread.records())).some(row => row.event.type === "StateInitialised")).toBe(false)
    const database = new Database(bunSupervisorPath(storage, "fixture", "main"), { readonly: true })
    try {
      for (const row of database.query<{event: string}, []>("SELECT event FROM experimental_events WHERE actor = 'supervisor'").all()) {
        const record = JSON.parse(row.event) as {event: {type: string; allocation?: object}}
        if (record.event.type === "ThreadRequested") {
          expect(record.event.allocation).not.toHaveProperty("initialState")
          expect(record.event.allocation).not.toHaveProperty("initialStateDefaultKeys")
        }
      }
    } finally { database.close() }
    const pinned = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "pinned", initialState: { "fixture.mode": "first", "fixture.value": 7 } }))
    const explicitNull = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "null", initialState: { "fixture.mode": null } }))
    await Effect.runPromise(host.close)
    host = await open(storage, { "fixture.mode": "later" }, false, keys)
    const inherited = await Effect.runPromise(host.allocateChildThread({ parent: pinned.coordinate, name: "child" }))
    expect(inherited.get(mode)).toBe("first")
    expect(inherited.get(value)).toBe(0)
    expect((await Effect.runPromise(host.allocateChildThread({ parent: explicitNull.coordinate, name: "child" }))).get(mode)).toBeNull()
    const legacyAfterDefaults = await Effect.runPromise(host.allocateChildThread({ parent: legacy.coordinate, name: "after-defaults" }))
    expect((await Effect.runPromise(legacyAfterDefaults.records()))[1]?.event).toMatchObject({ type: "StateInitialised", initialState: { "fixture.mode": null } })
    const override = await Effect.runPromise(host.allocateChildThread({ parent: pinned.coordinate, name: "override", initialState: { "fixture.mode": "explicit" } }))
    expect(override.get(mode)).toBe("explicit")
    await Effect.runPromise(host.close)
    host = await open(storage, undefined, false, keys)
    expect((await Effect.runPromise(host.allocateChildThread({ parent: inherited.coordinate, name: "grandchild" }))).get(mode)).toBe("first")
    expect((await Effect.runPromise(host.allocateChildThread({ parent: override.coordinate, name: "grandchild" }))).get(mode)).toBe("explicit")
    expect((await Effect.runPromise(host.allocateChildThread({ parent: legacy.coordinate, name: "after-defaults" }))).get(mode)).toBeNull()
    const reused = await Effect.runPromise(host.allocateChildThread({ parent: pinned.coordinate, name: "child" }))
    expect(reused.coordinate).toEqual(inherited.coordinate)
    expect(reused.get(mode)).toBe("first")
    const directory = await Effect.runPromise(host.supervisorStore("main"))
    expect(directory.thread(reused.coordinate.thread).get()).not.toHaveProperty("initialState")
    expect(directory.thread(reused.coordinate.thread).get()).not.toHaveProperty("initialStateDefaultKeys")
    await expect(Effect.runPromise(host.allocateChildThread({ parent: {...pinned.coordinate, thread: "missing"}, name: "child" }))).rejects.toThrow("Unknown parent thread")
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("host defaults seed roots and native children before their first turn", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-defaults-"))
  const host = await open(storage, { "fixture.mode": "first" })
  try {
    const parent = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "parent" }))
    expect(parent.get(mode)).toBe("first")
    expect((await Effect.runPromise(parent.records()))[1]?.event).toMatchObject({ type: "StateInitialised", initialState: { "fixture.mode": "first" } })
    const child = await Effect.runPromise(host.allocateChildThread({ parent: parent.coordinate, name: "child" }))
    expect(child.get(mode)).toBe("first")
    const explicit = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "explicit", initialState: { "fixture.mode": "override" } }))
    expect(explicit.get(mode)).toBe("override")
    const directory = await Effect.runPromise(host.supervisorStore("main"))
    expect(directory.thread(parent.coordinate.thread).get()).not.toHaveProperty("initialStateDefaultKeys")
    expect(directory.thread(parent.coordinate.thread).get()).not.toHaveProperty("initialState")
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("idle and checkpointed historical threads keep their state when defaults appear", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-historical-"))
  let host = await open(storage)
  try {
    await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "idle" }))
    const checkpointed = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "checkpointed" }))
    await Effect.runPromise(checkpointed.methods.read(null, { id: "read" }))
    await Effect.runPromise(host.close)
    const database = new Database(bunThreadPath(storage, checkpointed.coordinate), { readonly: true })
    try { expect(database.query("SELECT position FROM checkpoint WHERE id = 1").get()).toBeDefined() }
    finally { database.close() }
    host = await open(storage, { "fixture.mode": "second" })
    for (const name of ["idle", "checkpointed"]) {
      const retained = await Effect.runPromise(host.allocateRootThread({ instance: "main", name }))
      expect(retained.get(mode)).toBeNull()
      expect((await Effect.runPromise(retained.records())).some(record => record.event.type === "StateInitialised")).toBe(false)
    }
    expect((await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "new" }))).get(mode)).toBe("second")
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("named explicit seeds preserve recorded defaults through configuration changes", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-named-defaults-"))
  const initialState = { "fixture.value": 7 }
  let host = await open(storage, { "fixture.mode": "first" })
  try {
    await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "retained", initialState }))
    await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "explicit", initialState: { ...initialState, "fixture.mode": "override" } }))
    for (const defaults of [{ "fixture.mode": "second" }, {}, undefined]) {
      await Effect.runPromise(host.close)
      host = await open(storage, defaults)
      const retained = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "retained", initialState }))
      expect(retained.get(mode)).toBe("first")
      expect(retained.get(value)).toBe(7)
      await expect(Effect.runPromise(host.allocateRootThread({ instance: "main", name: "retained", initialState: { "fixture.value": 8 } }))).rejects.toThrow("different initial state")
      await expect(Effect.runPromise(host.allocateRootThread({ instance: "main", name: "explicit", initialState }))).rejects.toThrow("different initial state")
      const explicit = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "explicit", initialState: { ...initialState, "fixture.mode": "override" } }))
      expect(explicit.get(mode)).toBe("override")
    }
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("failed provisioning retries use the original allocation defaults", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-provision-defaults-"))
  const initialState = { "fixture.value": 7 }
  let host = await open(storage, { "fixture.mode": "first" }, true)
  try {
    await expect(Effect.runPromise(host.allocateRootThread({ instance: "main", name: "retained", initialState }))).rejects.toThrow("Provision unavailable")
    await Effect.runPromise(Effect.exit(host.close))
    host = await open(storage, { "fixture.mode": "second" })
    const retained = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "retained", initialState }))
    expect(retained.get(mode)).toBe("first")
    expect(retained.get(value)).toBe(7)
    const records = await Effect.runPromise(retained.records())
    expect(records.filter(record => record.event.type === "ThreadCreated")).toHaveLength(1)
    expect(records.filter(record => record.event.type === "StateInitialised")).toHaveLength(1)
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("failed child provisioning retains inherited seed provenance after defaults disappear", async () => {
  const storage = await mkdtemp(join(tmpdir(), "host-child-retry-"))
  const keys = { "fixture.mode": null }
  const initialState = { "fixture.value": 7 }
  let host = await open(storage, { "fixture.mode": "host" }, false, keys)
  try {
    const parent = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "parent", initialState: { "fixture.mode": "recorded" } }))
    await Effect.runPromise(host.close)
    host = await open(storage, { "fixture.mode": "changed" }, true, keys)
    await expect(Effect.runPromise(host.allocateChildThread({ parent: parent.coordinate, name: "child", initialState }))).rejects.toThrow("Provision unavailable")
    await Effect.runPromise(Effect.exit(host.close))
    host = await open(storage)
    const child = await Effect.runPromise(host.allocateChildThread({ parent: parent.coordinate, name: "child", initialState }))
    expect(child.get(mode)).toBe("recorded")
    expect(child.get(value)).toBe(7)
    const records = await Effect.runPromise(child.records())
    expect(records.filter(record => record.event.type === "StateInitialised")).toHaveLength(1)
    const database = new Database(bunSupervisorPath(storage, "fixture", "main"), { readonly: true })
    try {
      const requests = database.query<{event: string}, []>("SELECT event FROM experimental_events WHERE actor = 'supervisor'").all()
        .map(row => JSON.parse(row.event) as {event: {type: string; allocation?: {name: string; initialState?: InitialState; initialStateDefaultKeys?: string[]}}})
        .filter(row => row.event.type === "ThreadRequested" && row.event.allocation?.name === "child")
        .map(row => row.event.allocation)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[1]).toMatchObject({ initialState: { "fixture.mode": "recorded", "fixture.value": 7 }, initialStateDefaultKeys: ["fixture.mode"] })
    } finally { database.close() }
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})
