import type { Envelope } from "@flamecast/core"

// The context-window projections: how big the record is, where the last checkpoint sits, and how
// much tail a checkpoint keeps verbatim. The render reads them and the compaction module writes
// the checkpoint, so they live between the two rather than inside either.

// Tokens estimated as characters over four. A real tokenizer is a dependency and a non-pure path,
// and every size decision has to fold the same on replay, so the estimate is a pure function of the
// recorded bytes. This is the one measure the guard and the retained tail share.
export const estimateTokens = (events: ReadonlyArray<Envelope>): number =>
  Math.ceil(events.reduce((total, event) => total + JSON.stringify(event).length, 0) / 4)

export interface Checkpoint {
  // The index the next span starts from. Events before it stay in the log, and the rendered context
  // reads the summary in their place.
  readonly upTo: number
  readonly summary: string
}

// The last checkpoint on the record, or the zero checkpoint when compaction never ran.
export const checkpointOf = (log: ReadonlyArray<Envelope>): Checkpoint => {
  let upTo = 0
  let summary = ""
  for (const event of log) {
    if (event.type !== "CompactionCompleted") continue
    upTo = Number(event.upTo ?? 0)
    summary = String(event.summary ?? "")
  }
  return { upTo, summary }
}

// Everything a render or a fire decision sees: the events after the checkpoint.
export const suffixOf = (log: ReadonlyArray<Envelope>): ReadonlyArray<Envelope> =>
  log.slice(checkpointOf(log).upTo)

// The index the retained tail starts at: the newest events whose tokens fit in `keepTokens`. Walked
// from the end, so the tail is bounded by tokens rather than by a fixed event count. The newest
// event is always kept, even when it alone is over the bound, so a render never renders nothing.
export const keepUpTo = (log: ReadonlyArray<Envelope>, keepTokens: number): number => {
  let tokens = 0
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event === undefined) continue
    tokens += estimateTokens([event])
    if (tokens > keepTokens) return Math.min(index + 1, Math.max(log.length - 1, 0))
  }
  return 0
}
