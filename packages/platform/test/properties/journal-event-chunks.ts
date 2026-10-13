import { Effect, Cause, Exit } from "effect"
import { checkpointDigest } from "@clavia/tardigrade-core"
import { isDeepStrictEqual } from "node:util"
import type { sqlJournal } from "../../src/shared/sql-journal"

// journalEventChunks verifies logical replay, indexed reads, reopening and transactional rollback under a SQL row limit.
export async function journalEventChunks(fixture: {
  readonly open: () => ReturnType<typeof sqlJournal>
  readonly execute: (query: string) => Iterable<Record<string, unknown>>
  readonly maxRowBytes: number
}) {
  const open = fixture.open
  let journal = open()
  const same = (a: unknown, b: unknown) => {
    if (!isDeepStrictEqual(a, b))
      throw new Error("Logical journal record changed")
  }
  const assert = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message)
  }
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const limit = fixture.maxRowBytes
  await run(journal.read)
  fixture.execute(
    `CREATE TRIGGER row_limit BEFORE INSERT ON experimental_events WHEN length(CAST(NEW.event AS BLOB))+length(CAST(NEW.actor AS BLOB))+32>${limit} BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END`
  )
  const message = {
    id: "large-input",
    from: { kind: "external" as const, id: "fixture" }
  }
  const record = {
    event: {
      type: "MessageReceived" as const,
      body: { type: "LargeInput", text: "é😀".repeat(400000) }
    },
    message
  }
  await run(journal.append(0, [record]))
  same(await run(journal.read), [record])
  same(await run(journal.readFirst), record)
  same(await run(journal.readMessage(message.id)), { position: 1, record })
  same(await run(journal.readAfter(0)), [record])
  same(await run(journal.readAfter(1)), [])
  const chunks = [
    ...fixture.execute(
      "SELECT length(payload)+length(CAST(actor AS BLOB))+32 AS bytes FROM experimental_event_chunks"
    )
  ]
  assert(chunks.length > 1, "Large input was not chunked")
  assert(
    chunks.every((c) => Number(c.bytes) <= limit),
    "Event chunk exceeded row limit"
  )
  await run(journal.close)
  journal = open()
  same(await run(journal.read), [record])
  same(await run(journal.readMessage(message.id)), { position: 1, record })
  const payload = new TextEncoder().encode("checkpoint".repeat(250000)),
    checkpoint = {
      position: 2,
      payload,
      digest: await run(checkpointDigest(payload))
    }
  fixture.execute(
    "CREATE TRIGGER fail_chunk BEFORE INSERT ON experimental_event_chunks WHEN NEW.seq=1 AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'Injected event chunk failure'); END"
  )
  const failure = await run(
    Effect.exit(
      journal.appendWithCheckpoint(
        1,
        [{ ...record, message: { ...message, id: "second" } }],
        checkpoint
      )
    )
  )
  assert(
    Exit.isFailure(failure) &&
      Cause.pretty(failure.cause).includes("Injected event chunk failure"),
    "Injected failure was not returned"
  )
  same(await run(journal.read), [record])
  same(await run(journal.readCheckpoint), undefined)
  same(await run(journal.readMessage("second")), undefined)
  assert(
    [...fixture.execute("SELECT * FROM experimental_event_chunks WHERE seq=1")]
      .length === 0,
    "Failed transaction retained event chunks"
  )
  fixture.execute("DROP TRIGGER fail_chunk")
  const second = { ...record, message: { ...message, id: "second" } }
  await run(journal.appendWithCheckpoint(1, [second], checkpoint))
  same(await run(journal.readCheckpoint), checkpoint)
  same(await run(journal.readAfter(1)), [second])
  await run(journal.close)
  journal = open()
  same(await run(journal.read), [record, second])
  same(await run(journal.readCheckpoint), checkpoint)
  fixture.execute(
    "DELETE FROM experimental_event_chunks WHERE seq=0 AND ordinal=1"
  )
  const corrupt = await run(Effect.exit(journal.readFirst))
  assert(Exit.isFailure(corrupt), "Missing event chunk was accepted")
  await run(journal.close)
  return {
    ok: true,
    eventBytes: new TextEncoder().encode(JSON.stringify(record)).byteLength,
    eventChunks: chunks.length,
    maxChunkRowBytes: Math.max(...chunks.map((c) => Number(c.bytes))),
    limit
  }
}
