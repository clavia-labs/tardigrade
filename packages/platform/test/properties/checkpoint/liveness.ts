import { strict as assert } from "node:assert"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, atom, atomCheckpointKey, event, createActorStore, createEventLog, decodeCheckpoint, defineActor, effectAtom, RuntimeError, type MessageJournal, type Recorded } from "@clavia/tardigrade-core"
import { checkpointAtom } from "../../fixtures/atoms/atom"
import { atomPopulation, Changed, type AtomPopulationKind } from "../../fixtures/atoms/population"

const Shown = event({ type: "Shown" })
const PopulationEvent = Schema.Union([Changed, Shown])

// atomCheckpointLiveness checks recovery and eligible persistence with reads and successful storage (quint/checkpoint/lazyAtomCheckpoint.qnt, readyEquivalent).
export async function atomCheckpointLiveness(kind: AtomPopulationKind, fixture: { readonly open: () => MessageJournal<typeof PopulationEvent.Type> & { readonly close: Effect.Effect<void, Error> } }) {
  let journal = fixture.open()
  let reads = 0
  let prefixPosition = 0
  const population = atomPopulation(kind, "liveness")
  const { members, expected } = population
  const records: Recorded<Changed>[] = []
  const visible = checkpointAtom(members[0]!.kind, { name: "liveness.visible", input: Shown, schema: Schema.Boolean, initial: false, reduce: () => true })
  const actor = defineActor("checkpoint-liveness", Effect.succeed({ schema: PopulationEvent, methods: {
    change: actorMethod({ inputSchema: Schema.Struct({ id: Schema.String, amount: Schema.Int }), outputSchema: Schema.Null,
      onReceive: Changed.from((input: { readonly id: string; readonly amount: number }) => input), result: () => ({ status: "completed", output: null }),
    }),
    show: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Null, onReceive: Shown.from(() => ({})), result: () => ({ status: "completed", output: null }) }),
  }, atom: effectAtom(get => ({ view: get(visible) ? members.map(member => get(member.node)) : null, events: {}, acts: {} })) }))
  const open = (everyEvents?: number) => Effect.runPromise(createActorStore({ actor, journal: { ...journal,
    read: () => { throw new RuntimeError("Runtime requested full history") },
    readAfter: () => { throw new RuntimeError("Runtime requested an unbounded suffix") },
    readBefore: () => { throw new RuntimeError("Runtime requested a full prefix") },
    readRange: (from, to) => { if (from < prefixPosition) reads++; return journal.readRange(from, to) },
    ...(journal.readFamily ? { readFamily: (family: Parameters<NonNullable<typeof journal.readFamily>>[0], key: string, from: number, to: number, order?: "asc" | "desc") => {
      if (from < prefixPosition) reads++
      return journal.readFamily!(family, key, from, to, order)
    } } : {}),
  }, journalReadBatchSize: 2, checkpoint: everyEvents === undefined ? { mode: "manual" } : { mode: "threshold", options: { everyEvents } }, actorContext: Context.pick(), services: () => Layer.empty }))
  let store = await open()
  let message = 0
  const changeAll = async (amount: number) => {
    for (const member of members) {
      await Effect.runPromise(store.receive({ method: "change", input: { id: member.key, amount } }, { id: String(message++), from: { kind: "external", id: "test" } }))
      records.push({ event: { type: "Changed", id: member.key, amount } })
    }
  }
  const expectedView = () => members.map(member => expected(member.key, records))
  const readView = () => members.map(member => store.get(member.node))
  try {
    await changeAll(1)
    await Effect.runPromise(store.checkpoint)
    const checkpoint = decodeCheckpoint(journal.readCheckpoint()!.payload)
    prefixPosition = checkpoint.position
    const identities = new Set(members.map(member => atomCheckpointKey(member.identity)))
    assert.ok(checkpoint.durable.every(entry => !identities.has(atomCheckpointKey(entry))))
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    store = await open()
    await changeAll(3)
    assert.equal(reads, 0)
    assert.deepEqual(readView(), expectedView())
    assert.ok(reads > 0)
    const loaded = reads
    assert.deepEqual(readView(), expectedView())
    assert.equal(reads, loaded)
    assert.equal(store.snapshot().retainedRecords, 0)
    await Effect.runPromise(store.receive({ method: "show", input: null }, { id: "show", from: { kind: "external", id: "test" } }))
    assert.deepEqual(store.getState().view, expectedView())
    await changeAll(2)
    assert.deepEqual(readView(), expectedView())
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    reads = 0
    population.resetReductions()
    store = await open()
    assert.deepEqual(store.getState().view, expectedView())
    assert.deepEqual(readView(), expectedView())
    assert.equal(reads, 0)
    for (const member of members) assert.equal(member.reductions, 0)
    const saved = decodeCheckpoint(journal.readCheckpoint()!.payload)
    await changeAll(4)
    const openCold = () => createEventLog({ schema: PopulationEvent, atoms: { empty: atom(null) }, checkpoint: { position: saved.position, durable: [] },
      readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily!, readAtomCheckpoint: journal.readAtomCheckpoint!,
    })
    let cold = openCold()
    try {
      population.resetReductions()
      for (const count of [1, 2]) {
        const snapshot = cold.replay(journal.readRange(saved.position, journal.readPosition()))
        for (const member of members) {
          assert.equal(snapshot.get(member.node), expected(member.key, records))
          assert.equal(member.reductions, count)
        }
        if (count === 1) { cold.dispose(); cold = openCold() }
      }
    } finally { cold.dispose() }
    await Effect.runPromise(store.close)
    store = await open(1)
    await changeAll(2)
    for (const member of members) assert.equal(journal.readAtomCheckpoint!(member.identity, journal.readPosition())!.state, expected(member.key, records))
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close) }
}
