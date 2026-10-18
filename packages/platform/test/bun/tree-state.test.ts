import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { createActorStore, defineActor, durableMerkleAtom, effectAtom, type ActorRuntime } from "@clavia/tardigrade-core"
import { sqlJournal } from "../../src/shared/sql-journal"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunJournal } from "../../src/bun"
import { treeActorFixture, TreeEvent } from "../properties/runtime/tree-state"
import { waitFor } from "../fixtures/wait"

for (const cancellation of [false, true]) test(`tree atom checkpoint and ${cancellation ? "cleanup" : "execution"} root retention`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "tree-state-"))
  const filename = join(directory, "actor.db")
  const db = new Database(filename)
  let journal = bunJournal<typeof TreeEvent.Type>({ filename, actor: "tree", checkpointTree: { collectEvery: 1, cacheBytes: 0 } })
  const calls: { phase: string; length: number; first: string | undefined; ref: unknown }[] = []
  const observe: Parameters<typeof treeActorFixture>[1] = (phase, input, ref) => Effect.sync(() => { calls.push({ phase, length: input.messages.length, first: input.messages[0]?.text, ref }) })
  let live = await Effect.runPromise(treeActorFixture(journal, observe))
  try {
    await Effect.runPromise(live.seed)
    await Effect.runPromise(live.store.checkpoint)
    await Effect.runPromise(live.start)
    await waitFor(() => Promise.resolve(calls), calls => calls.length > 0)
    const accepted = (await Effect.runPromise(journal.readInputs))[0]!
    const selection = accepted.request.selections![0]!
    const root = selection.root
    expect(accepted.request.input).toEqual({ messages: null })
    expect(JSON.stringify(accepted).length).toBeLessThan(1024)
    await Effect.runPromise(live.append)
    expect(live.store.getState().view.count).toBe(4097)
    if (cancellation) {
      await Effect.runPromise(live.store.cancel(accepted.ref, "stop"))
      await waitFor(() => Promise.resolve(calls), calls => calls.some(call => call.phase === "cleanup"))
      await Effect.runPromise(live.store.checkpoint)
    }
    expect((db.query("SELECT * FROM grove_owners WHERE name LIKE '%input%'").all()).length).toBe(1)
    await Effect.runPromise(live.store.close)
    await Effect.runPromise(journal.close)
    journal = bunJournal<typeof TreeEvent.Type>({ filename, actor: "tree", checkpointTree: { collectEvery: 1, cacheBytes: 0 } })
    live = await Effect.runPromise(treeActorFixture(journal, observe))
    await waitFor(() => Promise.resolve(calls), calls => calls.length >= (cancellation ? 3 : 2))
    expect(calls.every(call => call.length === 4096 && call.first === `0:${"x".repeat(2048)}`)).toBe(true)
    expect(calls.every(call => JSON.stringify(call.ref) === JSON.stringify(accepted.ref))).toBe(true)
    expect(live.store.getState().view.count).toBe(4097)
    await Effect.runPromise(cancellation ? live.finishCleanup : live.finish)
    await Effect.runPromise(live.store.wait)
    await Effect.runPromise(live.store.checkpoint)
    expect((await Effect.runPromise(journal.readInputs)).length).toBe(0)
    expect(db.query("SELECT * FROM grove_owners WHERE name LIKE '%input%'").all().length).toBe(0)
    expect(db.query("SELECT * FROM grove_nodes WHERE hash = ?").all(root).length).toBe(0)
    const saved = await Effect.runPromise(journal.readCheckpoint)
    expect(saved!.payload.length).toBeLessThan(4096)
  } finally {
    await Effect.runPromise(live.store.close)
    await Effect.runPromise(journal.close)
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30000)

test("synchronous projections read published state during a suspended journal transaction", async () => {
  const Changed = Schema.Struct({ type: Schema.Literal("Changed"), value: Schema.Int })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let suspended = false
    let send!: ActorRuntime<typeof Changed.Type>["send"]
    const journal = sqlJournal<typeof Changed.Type>({ actor: "concurrent-tree", syncTreeReads: true, checkpointTree: { cacheBytes: 0, collectEvery: 1 }, layer: Layer.succeed(SqlClient.SqlClient, sql), commit: work => sql.withTransaction(work.pipe(Effect.andThen(Effect.suspend(() => suspended ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)))) })
    const actor = defineActor("concurrent-tree", Effect.sync(() => {
      const state = durableMerkleAtom({ name: "value", input: Changed, schema: Schema.Struct({ value: Schema.Int }), initial: { value: 0 }, reduce: (state, event) => state.set(["value"], event.value) })
      return { schema: Changed, atom: effectAtom(get => ({ view: get(state), events: {}, acts: {} })) }
    }))
    const store = yield* createActorStore({ actor, journal, checkpoint: { mode: "threshold", options: { everyEvents: 1 } }, actorContext: Context.pick(), services: runtime => { send = runtime.send; return Layer.empty } })
    yield* send([{ type: "Changed", value: 1 }])
    suspended = true
    const next = yield* send([{ type: "Changed", value: 2 }]).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    expect(store.getState().view.read(["value"])).toBe(1)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(next)
    expect(store.getState().view.read(["value"])).toBe(2)
    yield* store.close
    yield* journal.close
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))))
}, 10000)

for (const treeCheckpoint of [false, true]) test(`checkpoint maxBytes includes referenced tree state (${treeCheckpoint ? "tree" : "byte"})`, async () => {
  const journal = bunJournal<typeof TreeEvent.Type>({ filename: ":memory:", actor: "tree-limit" })
  const { treeCheckpoint: _treeCheckpoint, ...byteJournal } = journal
  const live = await Effect.runPromise(treeActorFixture(treeCheckpoint ? journal : byteJournal, () => Effect.void, { maxBytes: 1024 }))
  try {
    await Effect.runPromise(live.seed)
    await expect(Effect.runPromise(live.store.checkpoint)).rejects.toThrow("Checkpoint exceeds maxBytes 1024")
    expect(await Effect.runPromise(journal.readCheckpoint)).toBeUndefined()
  } finally {
    await Effect.runPromise(live.store.close)
    await Effect.runPromise(journal.close)
  }
})
