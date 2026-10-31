import { strict as assert } from "node:assert"
import { Effect, Schema } from "effect"
import { act, atom, atomCheckpointKey, createEventLog, decodeCheckpoint, encodeCheckpoint, effectAtom, journalCommit, checkpointDigestSync } from "@clavia/tardigrade-core"
import { atomPopulation, Changed, type AtomPopulationKind } from "../../fixtures/atoms/population"
import type { sqlJournal } from "../../../src/shared/sql-journal"

// atomCheckpointStorageSafety checks atomic writes, pinned recovery, collection, and pending-work capture for each population.
export async function atomCheckpointStorageSafety(kind: AtomPopulationKind, fixture: {
  readonly open: () => ReturnType<typeof sqlJournal<Changed>>
  readonly execute: (query: string) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>
}) {
  const journal = fixture.open()
  const { members, expected } = atomPopulation(kind, "storage")
  const open = (checkpoint?: ReturnType<typeof decodeCheckpoint>) => createEventLog({ schema: Changed, atoms: { empty: atom(null) }, readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily, readAtomCheckpoint: journal.readAtomCheckpoint, ...(checkpoint ? { checkpoint } : {}) })
  const log = open()
  const persist = async (checkpoint: ReturnType<typeof decodeCheckpoint>) => {
    const payload = encodeCheckpoint(checkpoint)
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(journal.readPosition(), [], { position: checkpoint.position, payload, digest: checkpointDigestSync(payload) })))
  }
  const pendingLogs: { readonly dispose: () => void }[] = []
  const records: { readonly event: Changed }[] = []
  try {
    let current = log.initial
    for (const member of members) current.get(member.node)
    const append = async (amount: number) => {
      for (const member of members) {
        const event = { type: "Changed" as const, id: member.key, amount }
        const prepared = log.prepare(current, event)
        await Effect.runPromise(journalCommit(journal, () => journal.append(current.position, prepared.records)))
        current = log.publish(prepared)
        records.push({ event })
      }
    }
    await append(1)
    const savedPosition = current.position
    for (const member of members) assert.equal(current.get(member.node), expected(member.key, records))
    await append(3)
    const position = current.position
    const checkpoint = current.checkpoint()!
    assert.deepEqual(checkpoint.durable.map(entry => entry.position), members.map(() => savedPosition))
    await persist(checkpoint)
    current.releaseAtomCheckpoints()
    for (const member of members) {
      await assert.rejects(Effect.runPromise(journalCommit(journal, () => journal.append(position, [], { atomCheckpoints: [{ ...member.identity, position: savedPosition, state: 99 }] }))), /Pinned atom checkpoint cannot change/)
      await assert.rejects(Effect.runPromise(journalCommit(journal, () => journal.append(position, [{ event: { type: "Changed", id: member.key, amount: 9 } }], { atomCheckpoints: [{ ...member.identity, position: position + 2, state: 99 }] }))))
      assert.equal(journal.readPosition(), position)
      assert.equal(journal.readAtomCheckpoint(member.identity, position)!.state, expected(member.key, records, savedPosition))
    }
    const actor = journal.readCheckpoint()!
    assert.deepEqual(decodeCheckpoint(actor.payload), checkpoint)
    for (const member of members) {
      assert.equal(current.get(member.node), expected(member.key, records))
      assert.equal(journal.readAtomCheckpoint(member.identity, position)!.state, expected(member.key, records, savedPosition))
    }
    await Effect.runPromise(journalCommit(journal, () => journal.append(position, [], { atomCheckpoints: current.atomCheckpoints() })))
    for (const member of members) assert.equal(journal.readAtomCheckpoint(member.identity, position)!.state, expected(member.key, records))
    assert.deepEqual(journal.readCheckpoint(), actor)
    const snapshots = await fixture.execute("SELECT name, family, position, pinned FROM atom_checkpoints")
    assert.equal(snapshots.length, members.length * 2)
    assert.equal(snapshots.filter(row => row.pinned === 1).length, members.length)
    const restored = open(decodeCheckpoint(actor.payload))
    try { for (const member of members) assert.equal(restored.initial.get(member.node), expected(member.key, records)) }
    finally { restored.dispose() }
    await persist(current.checkpoint()!)
    const collected = await fixture.execute("SELECT position, pinned FROM atom_checkpoints")
    assert.equal(collected.length, members.length)
    assert.ok(collected.every(row => row.position === position && row.pinned === 1))
    const Job = act({ name: "storage.pending", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const request = Job.request({ input: null })
    const pendingLog = createEventLog({ schema: Changed, atoms: { pending: effectAtom(get => ({ view: members.map(member => get(member.node)), events: {}, acts: { job: request } })) }, checkpoint: { position, durable: [] }, readRange: journal.readRange, readOperation: journal.readOperation, readFamily: journal.readFamily, readAtomCheckpoint: journal.readAtomCheckpoint })
    pendingLogs.push(pendingLog)
    const initial = pendingLog.initial
    const work = initial.effects()[0]!
    const event = pendingLog.requestEvent({ seq: position, atom: work.atom, act: work.request.act }, work.request)
    const prepared = pendingLog.prepare(initial, event)
    assert.equal(prepared.next.checkpoint(), undefined)
    const pendingSnapshots = prepared.next.atomCheckpoints()
    const keys = new Set(pendingSnapshots.map(atomCheckpointKey))
    for (const member of members) assert.ok(keys.has(atomCheckpointKey(member.identity)))
    await Effect.runPromise(journalCommit(journal, () => journal.append(position, prepared.records, { atomCheckpoints: pendingSnapshots })))
    for (const member of members) assert.equal(journal.readAtomCheckpoint(member.identity, prepared.next.position)!.position, prepared.next.position)
    assert.equal(journal.readCheckpoint()!.position, position)
    await fixture.execute("UPDATE atom_checkpoint_chunks SET payload = x'00'")
    for (const member of members) assert.throws(() => journal.readAtomCheckpoint(member.identity, prepared.next.position))
  } finally { for (const pending of pendingLogs) pending.dispose(); log.dispose(); await Effect.runPromise(journal.close) }
}
