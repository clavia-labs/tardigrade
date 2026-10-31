import { Effect, Schema } from "effect"
import { durableAtom } from "@clavia/tardigrade-core/experimental"
import { strict as assert } from "node:assert"
import { checkpointDigestSync, decodeCheckpoint, encodeAtomCheckpoint, decodeAtomCheckpoint, encodeCheckpoint, encodeActorCheckpointV4, encodeCheckpointManifest, decodeCheckpointManifest, journalCommit, type EffectCheckpoint, atom, createEventLog } from "@clavia/tardigrade-core"
import type { sqlJournal } from "../../../src/shared/sql-journal"

type Event = { readonly type: "Stored"; readonly value: string }

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

// checkpointFormats checks actor, atom, and manifest contracts without a storage fixture.
export function checkpointFormats(): void {
  const regular = { name: "state", state: { text: "é😀".repeat(40) }, position: 1 }
  const family = { name: "count", family: "counters", version: "1", position: 0, state: 12 }
  const versioned = { ...family, version: "2", state: 15 }
  const emptyKey = { ...family, name: "", state: 3 }
  const state = { position: 1, durable: [regular] }
  const encoded = JSON.parse(new TextDecoder().decode(encodeCheckpoint(state))) as Record<string, unknown>
  assert.equal(encoded.version, 5)
  assert.deepEqual(Object.keys(encoded).sort(), ["durable", "position", "version"])
  for (const checkpoint of [state, { position: 1, durable: [regular, family, versioned, emptyKey] }]) {
    assert.deepEqual(decodeCheckpoint(encodeCheckpoint(checkpoint)), checkpoint)
    const manifest = decodeCheckpointManifest(encodeCheckpointManifest(checkpoint))
    assert.deepEqual(manifest, { version: 2, checkpointVersion: 5, position: checkpoint.position,
      atoms: checkpoint.durable.map(({ state: _state, ...reference }) => reference),
    })
  }
  for (const invalid of [{ ...encoded, operations: [] }, { ...encoded, version: 99 }]) assert.throws(() => decodeCheckpoint(json(invalid)))
  const valid = { position: 1, durable: [{ name: "state", state: null, position: 1 }] }
  const invalidIdentities = [
    { ...valid.durable[0]!, name: "" }, { ...valid.durable[0]!, name: " " },
    { ...valid.durable[0]!, name: 1 },
    { ...valid.durable[0]!, family: "counters" }, { ...valid.durable[0]!, version: "1" },
    { ...family, family: "" }, { ...family, version: "" },
  ]
  const invalidReferences = [...invalidIdentities, { ...valid.durable[0]!, position: 2 }]
  for (const invalid of [
    { ...valid, position: -1 }, { ...valid, position: 0.5 }, { ...valid, position: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, durable: null }, { ...valid, operations: [] },
    { ...valid, durable: [valid.durable[0]!, valid.durable[0]!] },
    ...[...invalidReferences, { ...valid.durable[0]!, state: undefined }, { ...valid.durable[0]!, extra: true }].map(entry => ({ ...valid, durable: [entry] })),
  ]) {
    assert.throws(() => encodeCheckpoint(invalid as EffectCheckpoint))
    assert.throws(() => decodeCheckpoint(json({ version: 5, ...invalid })))
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, () => null]) assert.throws(() => encodeCheckpoint({ ...valid, durable: [{ ...valid.durable[0]!, state: value }] }))
  for (const checkpoint of [valid, { position: 1, durable: [family, versioned, emptyKey] }]) {
    for (const entry of checkpoint.durable) assert.deepEqual(decodeAtomCheckpoint(encodeAtomCheckpoint(entry)), entry)
  }
  const atom = { name: "count", position: 0, state: 7 }
  assert.equal(new TextDecoder().decode(encodeAtomCheckpoint(atom)), '{"version":1,"checkpoint":{"name":"count","position":0,"state":7}}')
  for (const invalid of [null, [], {}, { version: 99, checkpoint: atom }, { version: 1 }, { checkpoint: atom }, { version: 1, checkpoint: atom, extra: true }]) assert.throws(() => decodeAtomCheckpoint(json(invalid)))
  assert.throws(() => encodeAtomCheckpoint({ name: "count", family: "counters", position: 0, state: 0 }))
  for (const invalid of invalidIdentities) {
    assert.throws(() => encodeAtomCheckpoint(invalid as typeof atom))
    assert.throws(() => decodeAtomCheckpoint(json({ version: 1, checkpoint: invalid })))
  }
  for (const entries of [[valid.durable[0]!, valid.durable[0]!], ...invalidReferences.map(entry => [entry])]) {
    assert.throws(() => encodeCheckpointManifest({ position: 1, durable: entries } as EffectCheckpoint))
    assert.throws(() => decodeCheckpointManifest(json({ version: 2, checkpointVersion: 5, position: 1, atoms: entries.map(({ state: _state, ...reference }) => reference) })))
  }
  const legacy = { position: 1, durable: [{ name: "state", state: null, position: 1 }] }
  assert.equal(new TextDecoder().decode(encodeActorCheckpointV4(legacy)), '{"version":4,"position":1,"durable":[{"name":"state","state":null,"position":1}]}')
  assert.deepEqual(decodeCheckpoint(encodeActorCheckpointV4(legacy)), legacy)
  const legacyManifest = { version: 2, checkpointVersion: 4, position: 1, atoms: [{ name: "state", position: 1 }] }
  assert.deepEqual(decodeCheckpointManifest(encodeCheckpointManifest(legacy, 4)), legacyManifest)
  assert.deepEqual(decodeCheckpointManifest(json({ version: 1, position: 1, atoms: ["state"] })), legacyManifest)
  for (const entries of [[{ ...regular, position: 0 }], [family]]) {
    assert.throws(() => encodeActorCheckpointV4({ position: 1, durable: entries }))
    assert.throws(() => decodeCheckpoint(json({ version: 4, position: 1, durable: entries })))
    assert.throws(() => encodeCheckpointManifest({ position: 1, durable: entries }, 4))
    assert.throws(() => decodeCheckpointManifest(json({ version: 2, checkpointVersion: 4, position: 1, atoms: entries.map(({ state: _state, ...reference }) => reference) })))
  }
}

// checkpointSchema checks legacy migration, shared atom identities, recovery manifests, and schema compatibility on both SQL hosts.
export async function checkpointSchema(fixture: {
  readonly open: () => ReturnType<typeof sqlJournal<Event>>
  readonly execute: (query: string) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>
}) {
  const checkpoint = { position: 0, durable: [{ name: "count", position: 0, state: 7 }] }
  const payload = encodeCheckpoint(checkpoint)
  const legacyPayload = encodeActorCheckpointV4(checkpoint)
  const hex = [...legacyPayload].map(byte => byte.toString(16).padStart(2, "0")).join("")
  await fixture.execute("CREATE TABLE checkpoint (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL)")
  await fixture.execute("CREATE TABLE checkpoint_chunks (ordinal INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
  await fixture.execute(`INSERT INTO checkpoint VALUES (1, 0, ${legacyPayload.byteLength}, 1, '${checkpointDigestSync(legacyPayload)}')`)
  await fixture.execute(`INSERT INTO checkpoint_chunks VALUES (0, x'${hex}')`)
  await fixture.execute("CREATE TABLE atom_checkpoints (injected INTEGER)")
  let journal = fixture.open()
  try {
    assert.throws(() => journal.readCheckpoint())
    assert.deepEqual(await fixture.execute("SELECT migration_id FROM checkpoint_migrations"), [])
    const originalColumns = await fixture.execute("PRAGMA table_info(checkpoint)")
    assert.ok(!originalColumns.some(column => column.name === "tag" || column.name === "encoding"))
    await Effect.runPromise(journal.close)
    await fixture.execute("DROP TABLE atom_checkpoints")
    journal = fixture.open()
    assert.deepEqual(journal.readCheckpoint()!.payload, legacyPayload)
    assert.deepEqual(await fixture.execute("SELECT migration_id FROM checkpoint_migrations ORDER BY migration_id"), [{ migration_id: 1 }, { migration_id: 2 }, { migration_id: 3 }])
    const columns = await fixture.execute("PRAGMA table_info(atom_checkpoints)")
    assert.ok(!columns.some(column => column.name === "actor"))
    const family = { name: "count", family: "counters", version: "1", position: 0, state: 12 }
    const versioned = { ...family, version: "2", state: 15 }
    const emptyKey = { ...family, name: "", state: 3 }
    const stored = { position: 0, payload, digest: checkpointDigestSync(payload) }
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [], stored, { atomCheckpoints: [family, versioned, emptyKey] })))
    const rows = await fixture.execute("SELECT name, family, version FROM atom_checkpoints ORDER BY family, version, name")
    assert.deepEqual(rows, [
      { name: "count", family: null, version: null },
      { name: "", family: "counters", version: "1" },
      { name: "count", family: "counters", version: "1" },
      { name: "count", family: "counters", version: "2" },
    ])
    assert.equal(journal.readAtomCheckpoint({ name: "count" }, 0)!.state, 7)
    assert.equal(journal.readAtomCheckpoint(family, 0)!.state, 12)
    assert.equal(journal.readAtomCheckpoint(versioned, 0)!.state, 15)
    assert.deepEqual(decodeCheckpoint(journal.readCheckpoint()!.payload), checkpoint)
    const manifest = await fixture.execute("SELECT encoding, storage_byte_length FROM checkpoint")
    assert.equal(manifest[0]!.encoding, 1)
    const bytes = await fixture.execute("SELECT payload FROM checkpoint_chunks ORDER BY ordinal")
    const manifestText = bytes.map(row => new TextDecoder().decode(row.payload as Uint8Array)).join("")
    assert.deepEqual(JSON.parse(manifestText), { version: 2, checkpointVersion: 5, position: 0, atoms: [{ name: "count", position: 0 }] })
    await fixture.execute("CREATE TRIGGER fail_atom_chunk BEFORE INSERT ON atom_checkpoint_chunks BEGIN SELECT RAISE(ABORT, 'Injected atom chunk failure'); END")
    const nextPayload = encodeCheckpoint({ position: 1, durable: [{ name: "count", position: 1, state: 99 }] })
    await assert.rejects(Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [{ event: { type: "Stored", value: "rollback" } }], { position: 1, payload: nextPayload, digest: checkpointDigestSync(nextPayload) }))))
    assert.equal(journal.readPosition(), 0)
    assert.equal(journal.readAtomCheckpoint({ name: "count" }, 0)!.state, 7)
    assert.deepEqual(journal.readCheckpoint(), stored)
    await fixture.execute("DROP TRIGGER fail_atom_chunk")
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    assert.deepEqual(journal.readCheckpoint(), stored)
    const opaque = new Uint8Array([1, 2, 3])
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [], { position: 0, payload: opaque, digest: checkpointDigestSync(opaque), tag: "other-layout" })))
    assert.equal(journal.readCheckpoint("unrelated"), undefined)
    assert.deepEqual(journal.readCheckpoint("other-layout")!.payload, opaque)
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [], stored)))
    const collision = JSON.stringify(["counters", "1", "count"])
    const collisionState = { position: 1, durable: [{ name: collision, position: 1, state: 999 }] }
    const collisionPayload = encodeCheckpoint(collisionState)
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [{ event: { type: "Stored", value: "count" } }], { position: 1, payload: collisionPayload, digest: checkpointDigestSync(collisionPayload) })))
    const Event = Schema.Struct({ type: Schema.Literal("Stored"), value: Schema.String })
    const familyAtoms = durableAtom.family({ name: "counters", input: Event, schema: Schema.Int, initial: 12, key: event => event.value, reduce: state => state + 1 })
    const log = createEventLog({ schema: Event, atoms: { empty: atom(null) }, checkpoint: collisionState,
      readRange: journal.readRange, readOperation: journal.readOperation, readAtomCheckpoint: journal.readAtomCheckpoint,
    })
    try { assert.equal(log.initial.get(familyAtoms("count")), 13) }
    finally { log.dispose() }
    const legacyPosition = journal.readPosition()
    const legacyActor = encodeActorCheckpointV4({ position: legacyPosition, durable: [{ name: "count", state: 7, position: legacyPosition }] })
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(legacyPosition, [], { position: legacyPosition, payload: legacyActor, digest: checkpointDigestSync(legacyActor) })))
    await Effect.runPromise(journal.close)
    const legacyManifest = new TextEncoder().encode(JSON.stringify({ version: 1, position: legacyPosition, atoms: ["count"] }))
    const manifestHex = [...legacyManifest].map(byte => byte.toString(16).padStart(2, "0")).join("")
    await fixture.execute("DELETE FROM checkpoint_chunks")
    await fixture.execute(`INSERT INTO checkpoint_chunks VALUES (0, x'${manifestHex}')`)
    await fixture.execute(`UPDATE checkpoint SET chunk_count = 1, storage_byte_length = ${legacyManifest.byteLength}, storage_digest = '${checkpointDigestSync(legacyManifest)}'`)
    await fixture.execute("ALTER TABLE atom_checkpoints DROP COLUMN pinned")
    await fixture.execute("DROP INDEX atom_checkpoint_name")
    await fixture.execute("DROP INDEX atom_checkpoint_family")
    await fixture.execute("CREATE UNIQUE INDEX atom_checkpoint_name ON atom_checkpoints(name) WHERE family IS NULL")
    await fixture.execute("CREATE UNIQUE INDEX atom_checkpoint_family ON atom_checkpoints(family, version, name) WHERE family IS NOT NULL")
    await fixture.execute("DELETE FROM checkpoint_migrations WHERE migration_id = 3")
    journal = fixture.open()
    assert.deepEqual(journal.readCheckpoint()!.payload, legacyActor)
    await Effect.runPromise(journalCommit(journal, () => journal.append(legacyPosition, [{ event: { type: "Stored", value: "newer" } }], { atomCheckpoints: [{ name: "count", position: legacyPosition + 1, state: 8 }] })))
    assert.equal(journal.readAtomCheckpoint({ name: "count" }, legacyPosition + 1)!.state, 8)
    assert.deepEqual(journal.readCheckpoint()!.payload, legacyActor)
    await fixture.execute("UPDATE atom_checkpoint_chunks SET payload = x'00' WHERE atom_id IN (SELECT id FROM atom_checkpoints WHERE family IS NULL)")
    assert.throws(() => journal.readCheckpoint())
    await Effect.runPromise(journal.close)
    await fixture.execute("UPDATE checkpoint_migrations SET migration_id = 99 WHERE migration_id = 3")
    journal = fixture.open()
    assert.throws(() => journal.readPosition(), /Unsupported checkpoint SQL schema version/)
  } finally { await Effect.runPromise(journal.close) }
}
