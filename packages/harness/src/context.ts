import type { Event } from "@flamecast/core"

// The context-window projections: how big the record is, where the last checkpoint sits, and how
// much tail a checkpoint keeps verbatim. The render reads them and the compaction module writes
// the checkpoint, so they live between the two rather than inside either.

// Tokens estimated as characters over four. A real tokenizer is a dependency and a non-pure path,
// and every size decision has to fold the same on replay, so the estimate is a pure function of the
// recorded bytes. This is the one measure the guard, the retained tail, and the window check share.
//
// The estimate runs low: prose is close to four characters per token, and the JSON and code a tool
// returns are closer to three. A caller that reads it as "at least this many" is reading it right,
// which is why the window check refuses on it and nothing sizes a budget up from it.
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4)

export const estimateTokens = (events: ReadonlyArray<Event>): number =>
  estimateTextTokens(events.map((event) => JSON.stringify(event)).join(""))

export interface Checkpoint {
  // The index the next span starts from. Events before it stay in the log, and the rendered context
  // reads the summary in their place.
  readonly upTo: number
  readonly summary: string
}

// The last checkpoint on the record, or the zero checkpoint when compaction never ran.
export const checkpointOf = (log: ReadonlyArray<Event>): Checkpoint => {
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
export const suffixOf = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.slice(checkpointOf(log).upTo)

// The index the retained tail starts at: the newest events whose tokens fit in `keepTokens`. Walked
// from the end, so the tail is bounded by tokens rather than by a fixed event count. The newest
// event is always kept, even when it alone is over the bound, so a render never renders nothing.
export const keepUpTo = (log: ReadonlyArray<Event>, keepTokens: number): number => {
  let tokens = 0
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event === undefined) continue
    tokens += estimateTokens([event])
    if (tokens > keepTokens) return Math.min(index + 1, Math.max(log.length - 1, 0))
  }
  return 0
}
