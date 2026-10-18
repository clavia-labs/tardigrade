import { Cause, Effect, Exit } from "effect"
import { isDeepStrictEqual } from "node:util"
import { checkpointDigest, encodeCheckpoint, decodeCheckpoint, type Recorded, type PendingEffectInput, type Journal as CoreJournal } from "@clavia/tardigrade-core"

type Event = { readonly type: "Stored"; readonly value: string }
type Journal = CoreJournal<Event> & { readonly close: Effect.Effect<void, Error> }

// checkpointStorage checks replacement, rollback, reopening and corruption through the same SQL flow on both hosts.
export async function checkpointStorage(fixture: {
  readonly maxChunkBytes?: number
  readonly open: (chunkBytes: number) => Journal
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
    const rows = await fixture.execute("SELECT ordinal, length(payload) AS bytes, typeof(payload) AS kind FROM journal_checkpoint_chunks ORDER BY ordinal")
    const [header] = await fixture.execute("SELECT byte_length, chunk_count FROM journal_checkpoints WHERE id=1")
    if (header?.byte_length !== expected.payload.length || header?.chunk_count !== rows.length || rows.some((row, ordinal) => row.ordinal !== ordinal || row.kind !== "blob")) throw new Error("Checkpoint layout differs from its header")
    return rows.length
  }
  try {
    if (await Effect.runPromise(journal.readCheckpoint) !== undefined) throw new Error("Fresh database has a checkpoint")
    await Effect.runPromise(journal.appendWithCheckpoint(0, [record("first")], first))
    const largeCount = await verify(first, [record("first")])
    await fixture.execute("CREATE TRIGGER fail_checkpoint_chunk BEFORE INSERT ON journal_checkpoint_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected chunk failure'); END")
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
    await fixture.execute("UPDATE journal_checkpoint_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journal.readCheckpoint, "digest mismatch")
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], second))
    await fixture.execute("DELETE FROM journal_checkpoint_chunks WHERE ordinal = 0")
    await rejects(journal.readCheckpoint, "chunk metadata")
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], second))
    await verify(second, [record("first"), record("second")])
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    const boundary = await checkpoint(2, "x".repeat(chunkBytes))
    await Effect.runPromise(journal.appendWithCheckpoint(2, [], boundary))
    if (await verify(boundary, [record("first"), record("second")]) !== 2) throw new Error("Host-sized chunk failed its SQL round trip")
    const pending: PendingEffectInput = { ref: { seq: 2, atom: "model", act: "test.input" }, request: { act: "test.input", input: "é😀".repeat(chunkBytes) } }
    await fixture.execute("CREATE TRIGGER fail_input_chunk BEFORE INSERT ON journal_accepted_input_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected input failure'); END")
    await rejects(journal.append(2, [record("pending")], { put: [pending] }), "Injected input failure")
    if ((await Effect.runPromise(journal.read)).length !== 2 || (await Effect.runPromise(journal.readInputs)).length !== 0) throw new Error("Input failure committed a partial acceptance")
    await fixture.execute("DROP TRIGGER fail_input_chunk")
    await Effect.runPromise(journal.append(2, [record("pending")], { put: [pending] }))
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    if (!isDeepStrictEqual(await Effect.runPromise(journal.readInputs), [pending])) throw new Error("Pending input did not survive reopening")
    await rejects(journal.append(3, [], { put: [{ ...pending, request: { ...pending.request, input: "changed" } }] }), "cannot change")
    await fixture.execute("UPDATE journal_accepted_input_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journal.readInputs, "digest mismatch")
    await Effect.runPromise(journal.append(3, [record("settled")], { remove: [pending.ref] }))
    if ((await Effect.runPromise(journal.readInputs)).length || (await fixture.execute("SELECT * FROM journal_accepted_input_chunks")).length) throw new Error("Terminal input release retained payloads")
  } finally { await Effect.runPromise(journal.close) }
}

async function rejects(work: Effect.Effect<unknown, Error>, message: string) {
  const result = await Effect.runPromise(Effect.exit(work))
  if (Exit.isSuccess(result) || !Cause.pretty(result.cause).includes(message)) throw new Error(`Expected storage failure: ${message}`)
}
