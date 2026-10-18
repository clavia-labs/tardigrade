import assert from "node:assert/strict"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, createActorStore, defineActor, durableAtom, tree, effectAtom, event, MessageConflict } from "@clavia/tardigrade-core"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

// journalDelivery checks that actor receipts prevent repeated reductions across checkpoint and reopen (integration.ts).
export async function journalDelivery(driver: SyncSqlite, amount: number) {
  const Added = event({ type: "Added", amount: Schema.Int })
  const count = durableAtom({ name: "delivery.count", input: Added, schema: tree(Schema.Struct({ count: Schema.Int })), initial: { count: 0 }, reduce: (state, event) => state.set(["count"], state.read(["count"]) + event.amount) })
  const actor = defineActor("counter", Effect.succeed({ schema: Added,
    atom: effectAtom(get => ({ view: get(count).read(["count"]), events: {}, acts: {} })),
    methods: { add: actorMethod({ inputSchema: Schema.Int, outputSchema: Schema.Int, onReceive: Added.from(amount => ({ amount })), result: (_, get) => ({ status: "completed", output: get(count).read(["count"]) }) }) },
  }))
  let flushes = 0
  const open = () => synchronousJournal<typeof Added.Type>({ actor: "actor", driver, eventInlineBytes: 64, flush: Effect.sync(() => { flushes++ }) })
  let journal = open()
  const boot = () => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: Context.pick(), services: () => Layer.empty }))
  let store = await boot()
  const message = { id: "one", from: { kind: "external" as const, id: "sender" } }, request = { method: "add", input: amount }
  try {
    const first = await Effect.runPromise(store.receive(request, message)), before = flushes
    assert.deepEqual(await Effect.runPromise(store.receive(request, message)), first)
    assert.equal(flushes, before + 1)
    assert.equal(store.get(count).read(["count"]), amount)
    await assert.rejects(Effect.runPromise(store.receive({ method: "add", input: amount + 1 }, message)), MessageConflict)
    await assert.rejects(Effect.runPromise(store.receive(request, { ...message, from: { kind: "external", id: "other" } })), MessageConflict)
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(store.close); await Effect.runPromise(journal.close)
    journal = open(); store = await boot()
    assert.deepEqual(await Effect.runPromise(store.receive(request, message)), first)
    assert.equal(store.get(count).read(["count"]), amount)
    assert.equal((await Effect.runPromise(journal.read)).filter(record => record.message?.id === message.id).length, 1)
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close) }
}
