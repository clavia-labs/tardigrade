import { Effect } from "effect"
import type { DedupKey, Envelope } from "@flamecast/core"

// The event log as an array. It is the store the conformance kit runs against, and it needs no
// files and no keys.
//
// Small as it is, it owes the same six guarantees a SQLite file or a Durable Object owes, because
// the core folds the same way over all of them.
//
// 1. Append only. Nothing here deletes a row. A checkpoint is another append.
// 2. Total order. `seq` counts up and is never reused, so the watermark is exact.
// 3. One writer. A JavaScript process runs one fiber at a time and the append below takes no
//    suspension point, so a batch can not interleave with another writer's batch. The Writer port
//    is what serializes whole turns.
// 4. Atomic batch. The rows are prepared and then pushed in one synchronous pass, so a reader sees
//    the whole batch or none of it.
// 5. Dedup by key. A key that already landed absorbs its redelivery, inside one batch and across
//    batches. An event with no key always lands, which is why a repeated mark stays as evidence.
// 6. Watermark reads. `readFrom(seq)` returns the tail after `seq`.
export const inMemoryEventLog = (options: {
  readonly seed?: ReadonlyArray<Envelope>
  readonly keyOf: DedupKey
}) => {
  const keyOf = options.keyOf
  const rows: Array<{ readonly seq: number; readonly event: Envelope }> = []
  const keys = new Set<string>()
  let seq = 0

  const put = (events: ReadonlyArray<Envelope>) => {
    const landing: Array<{ readonly key: string | undefined; readonly event: Envelope }> = []
    const batch = new Set<string>()
    for (const event of events) {
      const key = keyOf(event)
      if (key !== undefined && (keys.has(key) || batch.has(key))) continue
      if (key !== undefined) batch.add(key)
      landing.push({ key, event })
    }
    for (const { key, event } of landing) {
      seq += 1
      rows.push({ seq, event })
      if (key !== undefined) keys.add(key)
    }
  }

  put(options.seed ?? [])

  return {
    append: (events: ReadonlyArray<Envelope>) => Effect.sync(() => put(events)),
    // A fresh array on every read: the log hands out its history, never its storage.
    read: Effect.sync(() => rows.map((row) => row.event)),
    readFrom: (from: number) =>
      Effect.sync(() => rows.filter((row) => row.seq > from).map((row) => row.event)),
    head: Effect.sync(() => rows.at(-1)?.seq ?? 0)
  }
}
