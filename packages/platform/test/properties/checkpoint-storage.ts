import { Cause, Effect, Exit } from "effect"
import { isDeepStrictEqual } from "node:util"
import { checkpointEncoder, checkpointDigest, encodeCheckpoint, decodeCheckpoint, type Recorded, type PendingEffectInput } from "@clavia/tardigrade-core"
import type { sqlJournal } from "../../src/shared/sql-journal"

type Event = { readonly type: "Stored"; readonly value: string }
type Journal = ReturnType<typeof sqlJournal<Event>>

// checkpointStorage checks replacement, rollback, reopening and corruption through the same SQL flow on both hosts.
export async function checkpointStorage(fixture: {
  readonly maxChunkBytes?: number
  readonly open: (chunkBytes: number, checkpointTree?: { readonly collectEvery?: number }) => Journal
  readonly execute: (query: string) => Promise<readonly Record<string, unknown>[]>
}) {
  const chunkBytes = fixture.maxChunkBytes ?? 2 * 1024 * 1024
  if (fixture.maxChunkBytes !== undefined) {
    let rejected = false
    try { fixture.open(chunkBytes + 1) } catch { rejected = true }
    if (!rejected) throw new Error("SQL journal accepted a chunk larger than the host row capacity")
  }
  const checkpoint = async (position: number, text: string) => {
    const state = { position, durable: [{ name: "state", state: { text }, position }], operations: [] }
    const payload = encodeCheckpoint(state)
    if (!isDeepStrictEqual(decodeCheckpoint(payload), state)) throw new Error("Checkpoint state failed codec round trip")
    return { position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
  }
  const record = (value: string): Recorded<Event> => ({ event: { type: "Stored", value } })
  const first = await checkpoint(1, "é😀".repeat(40))
  const second = await checkpoint(2, "small")
  let journal = fixture.open(7)
  const verify = async (expected: typeof first, records: readonly Recorded<Event>[]) => {
    const actual = await Effect.runPromise(journal.readCheckpoint)
    if (!isDeepStrictEqual(actual, expected) || !isDeepStrictEqual(await Effect.runPromise(journal.read), records)) throw new Error("Checkpoint or journal changed unexpectedly")
    const rows = await fixture.execute("SELECT ordinal, length(payload) AS bytes, typeof(payload) AS kind FROM checkpoint_chunks ORDER BY ordinal")
    const [header] = await fixture.execute("SELECT byte_length, chunk_count FROM checkpoint WHERE id = 1")
    if (header?.byte_length !== expected.payload.length || header?.chunk_count !== rows.length || rows.some((row, ordinal) => row.ordinal !== ordinal || row.kind !== "blob")) throw new Error("Checkpoint layout differs from its header")
    return rows.length
  }
  try {
    if (await Effect.runPromise(journal.readCheckpoint) !== undefined) throw new Error("Fresh database has a checkpoint")
    await Effect.runPromise(journal.appendWithCheckpoint(0, [record("first")], first))
    const largeCount = await verify(first, [record("first")])
    await fixture.execute("CREATE TRIGGER fail_checkpoint_chunk BEFORE INSERT ON checkpoint_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected chunk failure'); END")
    await rejects(journal.appendWithCheckpoint(1, [record("second")], second), "Injected chunk failure")
    await verify(first, [record("first")])
    await fixture.execute("DROP TRIGGER fail_checkpoint_chunk")
    await Effect.runPromise(journal.appendWithCheckpoint(1, [record("second")], second))
    if (await verify(second, [record("first"), record("second")]) >= largeCount) throw new Error("Smaller replacement retained stale chunks")
    await rejects(journal.appendWithCheckpoint(1, [record("stale")], second), "Journal conflict")
    await verify(second, [record("first"), record("second")])
    await Effect.runPromise(journal.close)
    journal = fixture.open(31)
    await verify(second, [record("first"), record("second")])
    await fixture.execute("UPDATE checkpoint_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journal.readCheckpoint, "digest mismatch")
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], second))
    await fixture.execute("DELETE FROM checkpoint_chunks WHERE ordinal = 0")
    await rejects(journal.readCheckpoint, "chunk metadata")
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], second))
    await verify(second, [record("first"), record("second")])
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    const boundary = await checkpoint(2, "x".repeat(chunkBytes))
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], boundary))
    if (await verify(boundary, [record("first"), record("second")]) !== 2) throw new Error("Host-sized chunk failed its SQL round trip")
    const pending: PendingEffectInput = { ref: { seq: 2, atom: "model", act: "test.input" }, request: { act: "test.input", input: "é😀".repeat(chunkBytes) } }
    await fixture.execute("CREATE TRIGGER fail_input_chunk BEFORE INSERT ON effect_input_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected input failure'); END")
    await rejects(journal.append(2, [record("pending")], { put: [pending] }), "Injected input failure")
    if ((await Effect.runPromise(journal.read)).length !== 2 || (await Effect.runPromise(journal.readInputs)).length !== 0) throw new Error("Input failure committed a partial acceptance")
    await fixture.execute("DROP TRIGGER fail_input_chunk")
    await Effect.runPromise(journal.append(2, [record("pending")], { put: [pending] }))
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    if (!isDeepStrictEqual(await Effect.runPromise(journal.readInputs), [pending])) throw new Error("Pending input did not survive reopening")
    await rejects(journal.append(3, [], { put: [{ ...pending, request: { ...pending.request, input: "changed" } }] }), "cannot change")
    await fixture.execute("UPDATE effect_input_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journal.readInputs, "digest mismatch")
    await Effect.runPromise(journal.append(3, [record("settled")], { remove: [pending.ref] }))
    if ((await Effect.runPromise(journal.readInputs)).length || (await fixture.execute("SELECT * FROM effect_input_chunks")).length) throw new Error("Terminal input release retained payloads")
    await Effect.runPromise(journal.close)
    journal = fixture.open(127, { collectEvery: 1 })
    const encodeTree = checkpointEncoder()
    const history = Object.freeze(Array.from({ length: 10000 }, (_, n) => Object.freeze({ n, text: `message ${n}` })))
    const treeCheckpoint = (position: number, status: string) => {
      const payload = encodeTree({ position, durable: [{ name: "history", state: Object.freeze({ history, status }), position }], operations: [] })
      return { position, payload, digest: payload.root }
    }
    const tree = treeCheckpoint(5, "ready")
    await fixture.execute("CREATE TRIGGER fail_tree_chunk BEFORE INSERT ON grove_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected tree failure'); END")
    await rejects(journal.treeCheckpoint.append(4, [record("tree")], tree), "Injected tree failure")
    if ((await Effect.runPromise(journal.read)).length !== 4 || (await Effect.runPromise(journal.readCheckpoint))?.digest !== boundary.digest) throw new Error("Tree failure replaced the legacy checkpoint or journal")
    if ((await fixture.execute("SELECT * FROM grove_nodes")).length) throw new Error("Tree failure leaked nodes")
    await fixture.execute("DROP TRIGGER fail_tree_chunk")
    await Effect.runPromise(journal.treeCheckpoint.append(4, [record("tree")], tree))
    if ((await fixture.execute("SELECT * FROM checkpoint")).length || (await fixture.execute("SELECT * FROM checkpoint_chunks")).length) throw new Error("Tree migration retained legacy checkpoint bytes")
    await Effect.runPromise(journal.close)
    journal = fixture.open(1024, { collectEvery: 1 })
    const restored = await Effect.runPromise(journal.treeCheckpoint.read)
    if (!restored || restored.payload instanceof Uint8Array || restored.payload.root !== tree.payload.root || !isDeepStrictEqual(decodeCheckpoint(restored.payload), decodeCheckpoint(tree.payload))) throw new Error("Tree checkpoint did not survive reopening")
    const bytes = await Effect.runPromise(journal.readCheckpoint)
    if (!bytes || !isDeepStrictEqual(decodeCheckpoint(bytes.payload), decodeCheckpoint(tree.payload)) || bytes.digest !== await Effect.runPromise(checkpointDigest(bytes.payload))) throw new Error("Byte checkpoint export differs from tree checkpoint")
    const before = (await fixture.execute("SELECT COUNT(*) AS n FROM grove_nodes"))[0]!.n as number
    const next = treeCheckpoint(5, "changed")
    await rejects(journal.treeCheckpoint.append(4, [], next), "Invalid checkpoint position")
    await Effect.runPromise(journal.treeCheckpoint.append(5, [], next))
    const after = (await fixture.execute("SELECT COUNT(*) AS n FROM grove_nodes"))[0]!.n as number
    if (Math.abs(after - before) > 10) throw new Error("Checkpoint replacement retained obsolete tree nodes")
    const replacement = await checkpoint(5, "legacy writer")
    await Effect.runPromise(journal.appendWithCheckpoint(5, [], replacement))
    if ((await fixture.execute("SELECT * FROM grove_nodes")).length || (await fixture.execute("SELECT * FROM checkpoint_trees")).length) throw new Error("Byte replacement retained tree ownership")
    if ((await Effect.runPromise(journal.readCheckpoint))?.digest !== replacement.digest) throw new Error("Byte replacement restored an older tree")
  } finally { await Effect.runPromise(journal.close) }
}

async function rejects(work: Effect.Effect<unknown, Error>, message: string) {
  const result = await Effect.runPromise(Effect.exit(work))
  if (Exit.isSuccess(result) || !Cause.pretty(result.cause).includes(message)) throw new Error(`Expected storage failure: ${message}`)
}
