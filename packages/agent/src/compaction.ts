import { Clock, Effect } from "effect"
import { EventLog } from "@flamecast/core/event-log"
import { transition, type Reactor } from "@flamecast/core/actor"
import { compactionCompleted } from "./events"
import type { Envelope } from "@flamecast/core/envelope"
import { Infer } from "./infer"

// The compaction reactor: a pure observer of the context size, with the hysteresis design. A guard
// fires compaction at a turn's end when the suffix since the last checkpoint passes FIRE, and the
// pass summarizes down to a KEEP-token tail, so it runs once per crossing instead of on every event
// after it. FIRE greater than KEEP is the hysteresis: the checkpoint drops the suffix well under
// FIRE, so the guard does not re-fire until the suffix regrows. The trigger is the guard, not the
// platform, so the whole decision is a pure fold of the log, byte-stable under replay.
// `CompactionCompleted` is the checkpoint: renders start from the summary plus the live suffix.
// Nothing is deleted; the full log stays for the rubric and replay. Consecutive fires with no
// completion between them are a crash-looping summarizer, and the usual give-up evidence applies.

// estimateTokens estimates the span's tokens as chars over four. A real tokenizer would be a
// dependency and an impure path, and every budget decision must fold the same on replay, so the
// estimate is a pure function of the recorded bytes. The guard and the tail share this one
// measure.
export const estimateTokens = (events: ReadonlyArray<Envelope>): number =>
  Math.ceil(events.reduce((n, e) => n + JSON.stringify(e).length, 0) / 4)

// COMPACTION_FIRE_TOKENS is the suffix size that fires a pass; COMPACTION_KEEP_TOKENS bounds the
// retained tail the pass summarizes down to.
export const COMPACTION_FIRE_TOKENS = 16_000
export const COMPACTION_KEEP_TOKENS = 4_000

// checkpointOf returns the last checkpoint: the index the next span starts from, and the summary
// to date.
export const checkpointOf = (log: ReadonlyArray<Envelope>): { readonly upTo: number; readonly summary: string } => {
  let upTo = 0
  let summary = ""
  for (const e of log) {
    if (e.type === "CompactionCompleted") {
      upTo = Number((e as { upTo?: unknown }).upTo ?? 0)
      summary = String((e as { summary?: unknown }).summary ?? "")
    }
  }
  return { upTo, summary }
}

// suffixOf returns everything after the checkpoint: the span a render or a fire decision sees.
export const suffixOf = (log: ReadonlyArray<Envelope>): ReadonlyArray<Envelope> => log.slice(checkpointOf(log).upTo)

// overContext reports whether the suffix has passed FIRE tokens. It is pure and total over the
// log, so the fire decision re-folds identically on replay: it reads only the log, no clock and
// no random source.
const overContext = (log: ReadonlyArray<Envelope>): boolean => estimateTokens(suffixOf(log)) > COMPACTION_FIRE_TOKENS

// keepUpTo returns the index the summary keeps from: the newest events whose tokens fit in KEEP.
// It walks from the end, so the retained tail is bounded by tokens rather than a fixed event
// count. The checkpoint never moves backward, so `prior.upTo` is the floor.
const keepUpTo = (log: ReadonlyArray<Envelope>): number => {
  let tokens = 0
  for (let i = log.length - 1; i >= 0; i--) {
    tokens += estimateTokens([log[i]!])
    // Keep the newest event even when it alone exceeds KEEP, so a render always has recent context.
    if (tokens > COMPACTION_KEEP_TOKENS) return Math.min(i + 1, log.length - 1)
  }
  return 0
}

const lineOf = (e: Envelope): string | null => {
  const v = e as Record<string, unknown>
  switch (e.type) {
    case "MessageReceived":
      return `user: ${String(v.text ?? "")}`
    case "TextReturned":
      return `agent (working): ${String(v.text ?? "")}`
    case "ToolCalled":
      return `agent ran: ${JSON.stringify(v.arguments ?? {}).slice(0, 200)}`
    case "ToolReturned":
      return `result: ${JSON.stringify(v.result ?? null).slice(0, 200)}`
    case "TurnCompleted":
      return `agent: ${String(v.output ?? "")}`
    case "TurnFailed":
      return `failed: ${String(v.error ?? "")}`
    default:
      return null
  }
}

// firedUncovered reports whether an explicit fire stands with no completion covering it, counted
// over the set.
const firedUncovered = (log: ReadonlyArray<Envelope>): boolean => {
  let fires = 0
  let passes = 0
  for (const e of log) {
    if (e.type === "CompactionFired") fires += 1
    if (e.type === "CompactionCompleted") passes += 1
  }
  return fires > passes
}

// turnEndedSinceCheckpoint gates the guard: a pass runs between turns, never mid-turn.
const turnEndedSinceCheckpoint = (log: ReadonlyArray<Envelope>): boolean =>
  suffixOf(log).some((e) => e.type === "ReplyDelivered")

// compactionReactor derives a pass when the suffix has crossed FIRE at a turn boundary, or an
// explicit `CompactionFired` stands uncovered. The act always advances the checkpoint (the
// retained tail is bounded by KEEP < FIRE), so a served pass quiets the derivation instead of
// re-firing. The checkpoint's key is where it reaches: cc:<upTo>. Its input is the span to fold,
// a projection, so a retried fire summarizes the same span. A crash-looping summarizer
// re-derives the same key and its retries absorb, while a later fire reaches further and keys
// anew.
export const compactionReactor: Reactor<Infer> = (log) => {
  if (!(firedUncovered(log) || (overContext(log) && turnEndedSinceCheckpoint(log)))) return []
  const prior = checkpointOf(log)
  const upTo = Math.max(prior.upTo, keepUpTo(log))
  const span = log.slice(prior.upTo, upTo)
  return [
    transition({
      key: `cc:${upTo}`,
      input: { upTo, summary: prior.summary, span },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const lines = input.span.map(lineOf).filter((l): l is string => l !== null)
          if (lines.length === 0) {
            return [compactionCompleted({ upTo: input.upTo, summary: input.summary, at })]
          }
          const brief = [
            "Summarize this agent history in a compact paragraph. Keep every fact a future turn could need: names, ids, decisions, unfinished work.",
            input.summary === "" ? "" : `Summary so far: ${input.summary}`,
            lines.join("\n")
          ].join("\n\n")
          const action = yield* (yield* Infer).react(
            [{ type: "MessageReceived", id: `compact-${input.upTo}`, text: brief, at }],
            `compact-${input.upTo}`
          )
          const summary = action.kind === "complete" ? action.output : input.summary
          return [compactionCompleted({ upTo: input.upTo, summary, at })]
        })
    })
  ]
}
