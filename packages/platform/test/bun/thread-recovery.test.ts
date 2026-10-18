import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { initializeThread, updateThreadVersion } from "@clavia/tardigrade-core/services/journal/thread"
import { bunJournal, createBunHost } from "../../src/bun"

const Changed = event({ type: "Changed", done: Schema.Boolean })
const done = durableAtom({ name: "recovery.done", input: Changed, schema: Schema.Boolean, initial: false, reduce: (_, event) => event.done })
const actor = defineActor("retained-reference", Effect.succeed({
  atom: effectAtom(get => ({ view: get(done), events: {}, acts: {} })),
  methods: { set: actorMethod({
    inputSchema: Schema.Boolean, outputSchema: Schema.Boolean,
    onReceive: Changed.from(done => ({ done })),
    result: (_, get) => get(done) ? { status: "completed", output: true } : undefined,
  }) },
}))

test("thread references and projections follow runtime replacement", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-thread-recovery-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    const selection = ref.store.select(done)
    const values: boolean[] = []
    const stop = selection.subscribe(value => { values.push(value) })
    await Effect.runPromise(host.invalidate(ref.coordinate))
    expect(() => ref.getState()).toThrow("unavailable during recovery")
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.invoke("set", true, { id: "after" }))
    await Effect.runPromise(ref.wait)
    expect(await Effect.runPromise(ref.methodState("set", "after"))).toEqual({ status: "completed", output: true })
    expect(ref.get(done)).toBe(true)
    expect(ref.getState().view).toBe(true)
    expect(selection.get()).toBe(true)
    expect(values).toEqual([true])
    stop()
    await Effect.runPromise(host.invalidate(ref.coordinate))
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.invoke("set", false, { id: "unsubscribed" }))
    await Effect.runPromise(ref.wait)
    expect(values).toEqual([true])
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("pending method results survive runtime replacement", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-result-recovery-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(ref.invoke("set", false, { id: "before" }))
    await Effect.runPromise(ref.wait)
    const waiter = Effect.runFork(ref.result("set", "before"))
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(host.invalidate(ref.coordinate))
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.methods.set(true, { id: "after" }).pipe(Effect.timeout(1_000)))
    expect(await Effect.runPromise(Fiber.join(waiter).pipe(Effect.timeout(1_000)))).toEqual({ status: "completed", output: true })
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})


test("replacement waits until the old runtime releases its services", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-lifecycle-recovery-"))
  const releasing = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let acquisitions = 0
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.effectDiscard(Effect.acquireRelease(
    Effect.sync(() => { acquisitions++ }),
    () => acquisitions === 1 ? Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
  )) }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    const invalidation = Effect.runFork(host.invalidate(ref.coordinate))
    await Effect.runPromise(Deferred.await(releasing))
    const recovery = Effect.runFork(host.recover(ref.coordinate))
    await Effect.runPromise(Effect.sleep(5))
    expect(acquisitions).toBe(1)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(invalidation))
    await Effect.runPromise(Fiber.join(recovery).pipe(Effect.timeout(1_000)))
    expect(acquisitions).toBe(2)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(host.close)
    await rm(storage, { recursive: true, force: true })
  }
})

test("thread versions record adoption once per change and preserve creation and state across rollback", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-thread-version-"))
  try {
    for (const [index, version] of ["v1", "v1", "v2", "v1"].entries()) {
      const host = await Effect.runPromise(createBunHost({ actor, storage, version, actorContext: Context.pick(), services: () => Layer.empty }))
      try {
        const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
        if (index === 0) await Effect.runPromise(thread.invoke("set", true, { id: "initial" }))
        await Effect.runPromise(thread.wait)
        expect(thread.get(done)).toBe(true)
        const records = await Effect.runPromise(thread.records())
        expect(records[0]!.event).toHaveProperty("version", "v1")
        const versions = records.flatMap(({ event }) => event.type === "ThreadUpdated" ? [event.version] : [])
        expect(versions).toEqual([[], [], ["v2"], ["v2", "v1"]][index]!)
      } finally { await Effect.runPromise(host.close) }
    }
  } finally { await rm(storage, { recursive: true, force: true }) }
})

test("version adoption reads lifecycle metadata without hydrating unrelated chunked history", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-version-metadata-"))
  const filename = join(storage, "thread.sqlite")
  const journal = bunJournal<{ type: "Payload"; body: string }>({ filename, actor: "events", eventInlineBytes: 128, checkpointChunkBytes: 64 })
  const address = { actor: "versioned", instance: "main", thread: "one" }
  try {
    await Effect.runPromise(initializeThread(journal, { type: "ThreadCreated", address, parent: null, depth: 0, placement: "independent", version: "v1" }))
    await Effect.runPromise(journal.append(1, [{ event: { type: "Payload", body: "payload".repeat(1_000) } }]))
    const database = new Database(filename)
    try { database.exec("DELETE FROM experimental_event_chunks WHERE seq = 1") }
    finally { database.close() }
    expect(await Effect.runPromise(Effect.flip(journal.read))).toBeInstanceOf(Error)
    const messages: unknown[] = []
    const logger = Logger.make(options => { messages.push(options.message) })
    const loggers = new Set([logger])
    const metadataOnly = { ...journal, read: Effect.die("Version adoption must not read actor history") }
    await Effect.runPromise(updateThreadVersion(metadataOnly, address, "v1").pipe(Effect.provideService(Logger.CurrentLoggers, loggers)))
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ version: "v1", position: 2, pendingEffects: 0 })
    await Effect.runPromise(updateThreadVersion(metadataOnly, address, "v2").pipe(Effect.provideService(Logger.CurrentLoggers, loggers)))
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ version: "v2", position: 3, pendingEffects: 0 })
    await Effect.runPromise(updateThreadVersion(metadataOnly, address, "v2").pipe(Effect.provideService(Logger.CurrentLoggers, loggers)))
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ version: "v2", position: 3, pendingEffects: 0 })
    expect(messages).toEqual([])
  } finally { await Effect.runPromise(journal.close); await rm(storage, { recursive: true, force: true }) }
})
