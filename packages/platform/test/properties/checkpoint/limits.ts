import { strict as assert } from "node:assert"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, createActorStore, defineActor, effectAtom, event, decodeCheckpoint, encodeCheckpointManifest, encodeAtomCheckpoint, DEFAULT_CHECKPOINT_MAX_BYTES } from "@clavia/tardigrade-core"
import { durableAtom } from "@clavia/tardigrade-core/experimental"
import type { sqlJournal } from "../../../src/shared/sql-journal"

const Stored = event({ type: "Stored", value: Schema.String })

// checkpointLimits checks the combined checkpoint-write budget, failure isolation, and consumer overrides on both SQL hosts.
export async function checkpointLimits(fixture: { readonly open: () => ReturnType<typeof sqlJournal<typeof Stored.Type>> }) {
  const initial = "i".repeat(256)
  const oversized = "x".repeat(initial.length + 128)
  const first = durableAtom({ name: "limits.first", input: Stored, schema: Schema.String, initial,
    reduce: (state, event) => event.value.startsWith("family:") ? state : event.value,
  })
  const second = durableAtom({ name: "limits.second", input: Stored, schema: Schema.String, initial, reduce: state => state })
  const members = durableAtom.family({ name: "limits.members", input: Stored, schema: Schema.String, initial,
    key: event => event.value.startsWith("family:") ? "rick" : undefined, reduce: (_state, event) => event.value.slice("family:".length),
  })
  const actor = defineActor("checkpoint-limits", Effect.succeed({ schema: Stored, methods: {
    store: actorMethod({ inputSchema: Schema.String, outputSchema: Schema.Null,
      onReceive: Stored.from((value: string) => ({ value })), result: () => ({ status: "completed", output: null }),
    }),
  }, atom: effectAtom(get => ({ view: [get(first), get(second), get(members("rick"))], events: {}, acts: {} })) }))
  const journal = fixture.open()
  const open = (limit: number) => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual", options: { maxBytes: limit } }, actorContext: Context.pick(), services: () => Layer.empty }))
  let store = await open(DEFAULT_CHECKPOINT_MAX_BYTES)
  let message = 0
  const change = (value: string) => Effect.runPromise(store.receive({ method: "store", input: value }, { id: String(message++), from: { kind: "external", id: "test" } }))
  try {
    await Effect.runPromise(store.checkpoint)
    const saved = journal.readCheckpoint()!
    const captured = decodeCheckpoint(saved.payload)
    const maxBytes = encodeCheckpointManifest(captured).byteLength + captured.durable.reduce((bytes, entry) => bytes + encodeAtomCheckpoint(entry).byteLength, 0)
    assert.ok(captured.durable.every(entry => encodeAtomCheckpoint(entry).byteLength < maxBytes))
    await Effect.runPromise(store.close)
    store = await open(maxBytes)
    await Effect.runPromise(store.checkpoint)
    assert.equal(journal.readAtomCheckpoint({ name: first.name }, journal.readPosition())!.state, initial)
    assert.equal(journal.readAtomCheckpoint({ name: "rick", family: members.name, version: members.indexVersion }, journal.readPosition())!.state, initial)
    await change(oversized)
    await assert.rejects(Effect.runPromise(store.checkpoint), /Checkpoint write exceeds maxBytes/)
    assert.equal(journal.readCheckpoint()!.digest, saved.digest)
    await change(initial)
    await change("family:" + oversized)
    await assert.rejects(Effect.runPromise(store.checkpoint), /Checkpoint write exceeds maxBytes/)
    assert.equal(journal.readCheckpoint()!.digest, saved.digest)
    await Effect.runPromise(store.close)
    store = await open(maxBytes * 4)
    await Effect.runPromise(store.checkpoint)
    assert.equal(journal.readAtomCheckpoint({ name: "rick", family: members.name, version: members.indexVersion }, journal.readPosition())!.state, oversized)
  } finally {
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
  }
}
