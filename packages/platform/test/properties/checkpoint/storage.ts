import { journalCall, journalCommit } from "@clavia/tardigrade-core"
import { Cause, Effect, Exit } from "effect"
import { isDeepStrictEqual } from "node:util"
import { checkpointDigest, encodeCheckpoint, JournalConflict, type Recorded, type PendingEffectInput, type InvocationIdentity, type EffectRef } from "@clavia/tardigrade-core"
import type { sqlJournal } from "../../../src/shared/sql-journal"

type Event = { readonly type: "Stored"; readonly value: string }
type Journal = ReturnType<typeof sqlJournal<Event>>

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
    const state = { position, durable: [{ name: "state", state: { text }, position }] }
    const payload = encodeCheckpoint(state)
    return { position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
  }
  const record = (value: string): Recorded<Event> => ({ event: { type: "Stored", value } })
  const first = await checkpoint(1, "é😀".repeat(40))
  const second = await checkpoint(2, "small")
  let journal = fixture.open(7)
  const verify = async (expected: typeof first, records: readonly Recorded<Event>[]) => {
    const actual = journal.readCheckpoint()
    if (!isDeepStrictEqual(actual, expected) || !isDeepStrictEqual(journal.read(), records)) throw new Error("Checkpoint or journal changed unexpectedly")
    const rows = await fixture.execute("SELECT ordinal, length(payload) AS bytes, typeof(payload) AS kind FROM checkpoint_chunks ORDER BY ordinal")
    const [header] = await fixture.execute("SELECT byte_length, chunk_count FROM checkpoint WHERE id = 1")
    if (header?.byte_length !== expected.payload.length || header?.chunk_count !== rows.length || rows.some((row, ordinal) => row.ordinal !== ordinal || row.kind !== "blob")) throw new Error("Checkpoint layout differs from its header")
    const atomChunks = await fixture.execute("SELECT c.ordinal, length(c.payload) AS bytes FROM atom_checkpoint_chunks c JOIN atom_checkpoints a ON a.id = c.atom_id WHERE a.name = 'state' AND a.family IS NULL ORDER BY c.ordinal")
    return atomChunks.length
  }
  try {
    if (journal.readCheckpoint() !== undefined) throw new Error("Fresh database has a checkpoint")
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(0, [record("first")], first)))
    const largeCount = await verify(first, [record("first")])
    await fixture.execute("CREATE TRIGGER fail_checkpoint_chunk BEFORE INSERT ON checkpoint_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected chunk failure'); END")
    await rejects(journalCommit(journal, () => journal.appendWithCheckpoint(1, [record("second")], second)), "Injected chunk failure")
    await verify(first, [record("first")])
    await fixture.execute("DROP TRIGGER fail_checkpoint_chunk")
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(1, [record("second")], second)))
    if (await verify(second, [record("first"), record("second")]) >= largeCount) throw new Error("Smaller replacement retained stale chunks")
    let conflict: unknown
    try { journal.appendWithCheckpoint(1, [record("stale")], second) } catch (cause) { conflict = cause }
    if (!(conflict instanceof JournalConflict)) throw new Error("Stale journal append did not throw JournalConflict synchronously")
    await verify(second, [record("first"), record("second")])
    await Effect.runPromise(journal.close)
    journal = fixture.open(31)
    await verify(second, [record("first"), record("second")])
    for (let position = 0; position <= 2; position++) {
      if (!isDeepStrictEqual(journal.readBefore(position), [record("first"), record("second")].slice(0, position))) throw new Error("Journal prefix read differed from chunked history")
      for (let to = position; to <= 2; to++) if (!isDeepStrictEqual(journal.readRange(position, to), [record("first"), record("second")].slice(position, to))) throw new Error("Journal range read differed from chunked history")
    }
    if (journal.readPosition() !== 2) throw new Error("Journal head differs from its stored prefix")
    for (const [from, to] of [[-1, 0], [0, -1], [1, 0], [0, 3], [3, 3], [0.5, 1], [0, 0.5], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]) {
      let rejected = false
      try { journal.readRange(from!, to!) } catch { rejected = true }
      if (!rejected) throw new Error("Journal range accepted an unavailable boundary")
    }
    for (const position of [-1, 0.5, 3, Number.NaN, Number.POSITIVE_INFINITY]) {
      let rejected = false
      try { journal.readBefore(position) } catch { rejected = true }
      if (!rejected) throw new Error("Journal prefix accepted an unavailable boundary")
    }
    await fixture.execute("UPDATE checkpoint_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journalCall(() => journal.readCheckpoint()), "digest mismatch")
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(2, [], second)))
    await fixture.execute("DELETE FROM checkpoint_chunks WHERE ordinal = 0")
    await rejects(journalCall(() => journal.readCheckpoint()), "chunk metadata")
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(2, [], second)))
    await verify(second, [record("first"), record("second")])
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    const boundary = await checkpoint(2, "x".repeat(chunkBytes))
    await Effect.runPromise(journalCommit(journal, () => journal.appendWithCheckpoint(2, [], boundary)))
    if (await verify(boundary, [record("first"), record("second")]) !== 2) throw new Error("Host-sized chunk failed its SQL round trip")
    const pending: PendingEffectInput = { ref: { seq: 2, atom: "model", act: "test.input" }, request: { act: "test.input", input: "é😀".repeat(chunkBytes) } }
    await fixture.execute("CREATE TRIGGER fail_input_chunk BEFORE INSERT ON effect_input_chunks WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'Injected input failure'); END")
    await rejects(journalCommit(journal, () => journal.append(2, [record("pending")], { put: [pending] })), "Injected input failure")
    if (journal.read().length !== 2 || journal.readInputs().length !== 0) throw new Error("Input failure committed a partial acceptance")
    await fixture.execute("DROP TRIGGER fail_input_chunk")
    await Effect.runPromise(journalCommit(journal, () => journal.append(2, [record("pending")], { put: [pending] })))
    await Effect.runPromise(journal.close)
    journal = fixture.open(chunkBytes)
    if (!isDeepStrictEqual(journal.readInputs(), [pending])) throw new Error("Pending input did not survive reopening")
    await rejects(journalCommit(journal, () => journal.append(3, [], { put: [{ ...pending, request: { ...pending.request, input: "changed" } }] })), "cannot change")
    await fixture.execute("UPDATE effect_input_chunks SET payload = zeroblob(length(payload)) WHERE ordinal = 0")
    await rejects(journalCall(() => journal.readInputs()), "digest mismatch")
    await Effect.runPromise(journalCommit(journal, () => journal.append(3, [record("settled")], { remove: [pending.ref] })))
    if (journal.readInputs().length || (await fixture.execute("SELECT * FROM effect_input_chunks")).length) throw new Error("Terminal input release retained payloads")

    const invocations: readonly { readonly identity: InvocationIdentity; readonly ref: EffectRef }[] = [
      { identity: { atom: "model", act: "lookup" }, ref: { seq: 4, atom: "model", act: "lookup" } },
      { identity: { atom: "model", act: "lookup", origin: 0 }, ref: { seq: 5, atom: "model", act: "lookup" } },
      { identity: { atom: "other", act: "lookup", origin: 0 }, ref: { seq: 6, atom: "other", act: "lookup" } },
      { identity: { atom: "model", act: "other", origin: 0 }, ref: { seq: 7, atom: "model", act: "other" } },
    ]
    const lookup = (index: number, status: "absent" | "pending" | "settled") => {
      const { identity, ref } = invocations[index]!
      const expected = status === "absent" ? { status } : { status, ref }
      if (!isDeepStrictEqual(journal.lookupInvocation(identity), expected)) throw new Error(`Invocation lookup differs from journal: ${index} ${status}`)
    }
    for (let index = 0; index < invocations.length; index++) lookup(index, "absent")
    const requests: Recorded<Event>[] = invocations.map(({ identity, ref }) => ({ event: {
      type: "EffectRequested", ref, ...(identity.origin === undefined ? {} : { origin: identity.origin }), request: { act: identity.act, input: { _tag: "InlineInput", value: "same input" } },
    } }))
    const operationRecords = (ref: EffectRef, position: number) => journal.read().slice(0, position).filter(({ event }) => "ref" in event && isDeepStrictEqual(event.ref, ref))
    const verifyOperation = (ref: EffectRef, position: number) => {
      if (!isDeepStrictEqual(journal.readOperation(ref, position), operationRecords(ref, position))) throw new Error("Indexed operation read differs from its journal prefix")
    }
    await Effect.runPromise(journalCommit(journal, journal.appendWithCheckpoint.bind(journal, 4, requests, await checkpoint(8, "accepted"))))
    for (let index = 0; index < invocations.length; index++) lookup(index, "pending")
    const unknown = journal.lookupInvocation({ atom: "model", act: "lookup", origin: 1 })
    if (unknown.status !== "absent") throw new Error("Distinct origin reused an invocation")
    const decisions: Recorded<Event>[] = [
      { event: { type: "EffectSettled", ref: invocations[0]!.ref, outcome: { status: "fulfilled", value: { type: "promise", handle: { executor: "external", id: "lookup" } } } } },
      { event: { type: "EffectSettled", ref: invocations[1]!.ref, outcome: { status: "fulfilled", value: { type: "value", value: "done" } } } },
      { event: { type: "EffectCancelled", ref: invocations[2]!.ref, reason: "stop" } },
      { event: { type: "EffectDied", ref: invocations[3]!.ref, diagnostic: "fixture defect" } },
    ]
    await fixture.execute("CREATE TRIGGER fail_invocation_index BEFORE INSERT ON experimental_invocation_events WHEN NEW.seq = 9 BEGIN SELECT RAISE(ABORT, 'Injected invocation index failure'); END")
    await rejects(journalCommit(journal, () => journal.append(8, decisions)), "Injected invocation index failure")
    for (let index = 0; index < invocations.length; index++) lookup(index, "pending")
    if (journal.read().length !== 8) throw new Error("Invocation index failure committed journal records")
    await fixture.execute("DROP TRIGGER fail_invocation_index")
    await Effect.runPromise(journalCommit(journal, journal.appendWithCheckpoint.bind(journal, 8, decisions, await checkpoint(12, "decided"))))
    lookup(0, "pending")
    lookup(1, "settled")
    lookup(2, "pending")
    lookup(3, "settled")
    await Effect.runPromise(journalCommit(journal, () => journal.append(12, [
      { event: { type: "PromiseSettled", ref: invocations[0]!.ref, result: { status: "rejected", reason: "fixture failure" } } },
      { event: { type: "CancellationSettled", ref: invocations[2]!.ref, outcome: { status: "fulfilled" } } },
    ])))
    await Effect.runPromise(journal.close)
    journal = fixture.open(31)
    for (let index = 0; index < invocations.length; index++) lookup(index, "settled")
    for (const { ref } of invocations) for (const position of [0, ref.seq, ref.seq + 1, 8, 12, 14]) verifyOperation(ref, position)
    verifyOperation({ ...invocations[0]!.ref, act: "missing" }, 14)
    for (const position of [-1, 0.5, 15, Number.NaN, Number.POSITIVE_INFINITY]) {
      let rejected = false
      try { journal.readOperation(invocations[0]!.ref, position) } catch { rejected = true }
      if (!rejected) throw new Error("Operation read accepted an unavailable boundary")
    }
    await fixture.execute("DELETE FROM experimental_invocation_events WHERE ref_seq = 4")
    await rejects(journalCall(() => journal.lookupInvocation(invocations[0]!.identity)), "missing journal records")
    await rejects(journalCall(() => journal.readOperation(invocations[0]!.ref, 14)), "missing journal records")
    await Effect.runPromise(journal.close)
    for (const table of ["experimental_invocation_events", "experimental_invocation_requests", "experimental_invocation_index"]) await fixture.execute(`DROP TABLE ${table}`)
    journal = fixture.open(31)
    for (let index = 0; index < invocations.length; index++) lookup(index, "settled")
    for (const { ref } of invocations) verifyOperation(ref, 14)
    if (journal.read().length !== 14) throw new Error("Invocation backfill changed journal history")
    const [chunk] = await fixture.execute("SELECT hex(payload) AS payload FROM experimental_event_chunks WHERE seq = 0 AND ordinal = 0")
    if (typeof chunk?.payload !== "string" || !/^[0-9A-F]+$/.test(chunk.payload)) throw new Error("Missing unrelated journal chunk")
    const expectedOperation = journal.readOperation(invocations[0]!.ref, 14)
    const expectedRange = journal.readRange(4, 5)
    try {
      await fixture.execute("UPDATE experimental_event_chunks SET payload = zeroblob(length(payload)) WHERE seq = 0 AND ordinal = 0")
      if (!isDeepStrictEqual(journal.readOperation(invocations[0]!.ref, 14), expectedOperation)) throw new Error("Operation lookup read unrelated journal history")
      if (!isDeepStrictEqual(journal.readRange(4, 5), expectedRange)) throw new Error("Journal range read unrelated chunked history")
    } finally { await fixture.execute(`UPDATE experimental_event_chunks SET payload = X'${chunk.payload}' WHERE seq = 0 AND ordinal = 0`) }
    const failedIdentity = { atom: "model", act: "lookup", origin: 2 }
    const failedRef = { seq: 14, atom: "model", act: "lookup" }
    await Effect.runPromise(journalCommit(journal, () => journal.append(14, [
      { event: { type: "EffectRequested", ref: failedRef, origin: 2, request: { act: "lookup", input: { _tag: "InlineInput", value: "same input" } } } },
      { event: { type: "EffectSettled", ref: failedRef, outcome: { status: "rejected", reason: "fixture failure" } } },
    ])))
    if (!isDeepStrictEqual(journal.lookupInvocation(failedIdentity), { status: "settled", ref: failedRef })) throw new Error("Rejected invocation remained pending")
    await Effect.runPromise(journal.close)
    await rejects(journalCall(() => journal.lookupInvocation(invocations[0]!.identity)), "Journal is closed")
    await rejects(journalCall(() => journal.readOperation(invocations[0]!.ref, 16)), "Journal is closed")
    await rejects(journalCall(() => journal.readPosition()), "Journal is closed")
    await rejects(journalCall(() => journal.readRange(0, 1)), "Journal is closed")
  } finally { await Effect.runPromise(journal.close) }
}

async function rejects(work: Effect.Effect<unknown, Error>, message: string) {
  const result = await Effect.runPromise(Effect.exit(work))
  if (Exit.isSuccess(result) || !Cause.pretty(result.cause).includes(message)) throw new Error(`Expected storage failure: ${message}`)
}
