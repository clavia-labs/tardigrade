import { Cause, Effect, Exit } from "effect"
import { isDeepStrictEqual } from "node:util"
import { checkpointDigest, encodeCheckpoint, decodeCheckpoint, type Recorded } from "@clavia/tardigrade-core"
import type { sqlJournal } from "../../src/shared/sql-journal"

type Event = { readonly type: "Stored"; readonly value: string }
type Journal = ReturnType<typeof sqlJournal<Event>>

// checkpointStorage checks replacement, rollback, reopening and corruption through the same SQL flow on both hosts.
export async function checkpointStorage(fixture: {
  readonly open: (chunkBytes: number) => Journal
  readonly execute: (query: string) => Promise<readonly Record<string, unknown>[]>
}) {
  const checkpoint = async (position: number, text: string) => {
    const state = { position, durable: [{ name: "state", state: { text }, position }], effects: [], promises: [] }
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
  } finally { await Effect.runPromise(journal.close) }
}

async function rejects(work: Effect.Effect<unknown, Error>, message: string) {
  const result = await Effect.runPromise(Effect.exit(work))
  if (Exit.isSuccess(result) || !Cause.pretty(result.cause).includes(message)) throw new Error(`Expected storage failure: ${message}`)
}
