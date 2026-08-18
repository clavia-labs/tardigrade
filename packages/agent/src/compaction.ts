import { Clock, Effect } from "effect"
import { transition, type Reactor } from "@flamecast/core/actor"
import { compactionCompleted } from "./events"
import type { Event } from "@flamecast/core/event"
import { turnOf, turnView } from "@flamecast/code/turns"
import { Infer } from "./infer"

// The compaction reactor: a pure observer of the context size, with the hysteresis design. A
// guard fires compaction at a resolved tool round, any moment the open turn awaits no call, when
// the rendered suffix since the last checkpoint passes FIRE. A long turn therefore sheds context
// while it runs, and the request stays bounded near FIRE under any window; a guard keyed to a
// turn's end starves the one shape that grows, a single long tool loop (compaction.test.ts,
// "fires inside an open turn"). The pass summarizes down to a KEEP-token tail. FIRE greater than
// KEEP is the hysteresis: the checkpoint drops the suffix well under FIRE, so the guard does not
// re-fire until the suffix regrows.
//
// The checkpoint names the first kept event by identity. The reactor folds the raw log while a
// render folds the projection (trajectoryOf), and an index into one array means a different
// event in the other the moment a queued message lands mid-turn; identity means the same event
// in both (request.test.ts, "a checkpoint survives the projection"). A cut lands only on a
// boundary that renders whole, a served turn head or a ToolCalled, so a kept tail never opens
// with a tool result whose call was summarized away, a conversation every provider rejects.
//
// `CompactionCompleted` is the checkpoint: renders start from the summary plus the live suffix.
// Nothing is deleted; the full log stays for the rubric and replay. Consecutive fires with no
// completion between them are a crash-looping summarizer, and the usual give-up evidence applies.

// The render's truncation caps, stated once beside the measure that must agree with them;
// request.ts renders with these.
export const MESSAGE_RENDER_CAP = 12_000
export const RESULT_RENDER_CAP = 6_000

// renderedChars counts the characters a render sends for one event: capped where the render
// caps, zero for an event the render skips. The guard must measure the request the model sees;
// a measure over raw event JSON counts tool results the render truncates and lanes the render
// never shows, and fires against a size no request ever reaches.
const renderedChars = (e: Event): number => {
  const v = e as Record<string, unknown>
  switch (e.type) {
    case "MessageReceived":
      return Math.min(String(v.text ?? "").length, MESSAGE_RENDER_CAP)
    case "TextReturned":
      return String(v.text ?? "").length
    case "ToolCalled":
      return JSON.stringify(v.arguments ?? {}).length
    case "ToolReturned":
      return Math.min(JSON.stringify(v.result ?? null).length, RESULT_RENDER_CAP)
    case "TurnCompleted":
      return String(v.output ?? "").length
    case "TurnFailed":
      return String(v.error ?? "").length
    default:
      return 0
  }
}

// estimateTokens estimates the span's rendered tokens as chars over four. A real tokenizer would
// be a dependency and an impure path, and every budget decision must fold the same on replay, so
// the estimate is a pure function of the recorded events (compaction.test.ts, "the measure").
export const estimateTokens = (events: ReadonlyArray<Event>): number =>
  Math.ceil(events.reduce((n, e) => n + renderedChars(e), 0) / 4)

// COMPACTION_FIRE_TOKENS is the rendered suffix size that fires a pass; COMPACTION_KEEP_TOKENS
// bounds the retained tail the pass summarizes down to.
export const COMPACTION_FIRE_TOKENS = 16_000
export const COMPACTION_KEEP_TOKENS = 4_000

// checkpointOf returns the last checkpoint: the identity the next span starts from, and the
// summary to date.
export const checkpointOf = (log: ReadonlyArray<Event>): { readonly keepFrom: string; readonly summary: string } => {
  let keepFrom = ""
  let summary = ""
  for (const e of log) {
    if (e.type === "CompactionCompleted") {
      keepFrom = String((e as { keepFrom?: unknown }).keepFrom ?? "")
      summary = String((e as { summary?: unknown }).summary ?? "")
    }
  }
  return { keepFrom, summary }
}

// keepFromIndex resolves a checkpoint identity in one sequence: the first index holding the
// named event, zero when the identity is empty or absent. Absence keeps everything, the safe
// side; the guard then re-fires and cuts anew.
export const keepFromIndex = (events: ReadonlyArray<Event>, keepFrom: string): number => {
  if (keepFrom === "") return 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const v = e as { callId?: unknown; id?: unknown }
    if (keepFrom.startsWith("c:") && e.type === "ToolCalled" && String(v.callId) === keepFrom.slice(2)) return i
    if (keepFrom.startsWith("m:") && e.type === "MessageReceived" && String(v.id) === keepFrom.slice(2)) return i
  }
  return 0
}

// suffixOf returns everything after the checkpoint: the span a render or a fire decision sees.
export const suffixOf = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.slice(keepFromIndex(log, checkpointOf(log).keepFrom))

// overContext reports whether the suffix has passed FIRE tokens. It is pure and total over the
// log, so the fire decision re-folds identically on replay: it reads only the log, no clock and
// no random source.
const overContext = (log: ReadonlyArray<Event>): boolean => estimateTokens(suffixOf(log)) > COMPACTION_FIRE_TOKENS

// atRoundBoundary gates the guard: a pass may land whenever the open turn awaits no tool call,
// between turns included. A checkpoint landing mid-round would cut a call from the return the
// world still owes it.
const atRoundBoundary = (log: ReadonlyArray<Event>): boolean => {
  const open = turnView(log)
  if (open.length === 0) return true
  const answered = new Set(
    open.filter((e) => e.type === "ToolReturned").map((e) => String((e as { callId?: unknown }).callId))
  )
  return !open.some((e) => e.type === "ToolCalled" && !answered.has(String((e as { callId?: unknown }).callId)))
}

// boundaryIdOf returns the identity a cut at this event would record: a ToolCalled keeps its
// return beside it, and a served head opens its turn whole. Any other position splits a pair or
// names an event the projection cannot see, so it is no boundary.
const boundaryIdOf = (e: Event, served: ReadonlySet<string>): string | undefined => {
  const v = e as { callId?: unknown; id?: unknown }
  if (e.type === "ToolCalled") return `c:${String(v.callId)}`
  if (e.type === "MessageReceived" && served.has(String(v.id))) return `m:${String(v.id)}`
  return undefined
}

// cutOf picks the next checkpoint: the newest boundary whose tail still fits KEEP, or failing
// that the first boundary past the KEEP line, so the checkpoint always advances when a boundary
// exists at all. The checkpoint never moves backward; no boundary past the prior one means no
// cut, and the fire waits for the next round to offer one.
const cutOf = (log: ReadonlyArray<Event>): { readonly keepFrom: string; readonly index: number } | undefined => {
  const priorIndex = keepFromIndex(log, checkpointOf(log).keepFrom)
  const served = new Set(log.map(turnOf).filter((t): t is string => t !== undefined))
  let tokens = 0
  let raw = priorIndex
  for (let i = log.length - 1; i >= priorIndex; i--) {
    tokens += estimateTokens([log[i]!])
    if (tokens > COMPACTION_KEEP_TOKENS) {
      raw = i + 1
      break
    }
  }
  for (let i = Math.min(raw, log.length - 1); i > priorIndex; i--) {
    const id = boundaryIdOf(log[i]!, served)
    if (id !== undefined) return { keepFrom: id, index: i }
  }
  for (let i = Math.max(raw + 1, priorIndex + 1); i < log.length; i++) {
    const id = boundaryIdOf(log[i]!, served)
    if (id !== undefined) return { keepFrom: id, index: i }
  }
  return undefined
}

const lineOf = (e: Event): string | null => {
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
const firedUncovered = (log: ReadonlyArray<Event>): boolean => {
  let fires = 0
  let passes = 0
  for (const e of log) {
    if (e.type === "CompactionFired") fires += 1
    if (e.type === "CompactionCompleted") passes += 1
  }
  return fires > passes
}

// compactionReactor derives a pass when the suffix has crossed FIRE at a round boundary, or an
// explicit `CompactionFired` stands uncovered. The act always advances the checkpoint (the
// retained tail is bounded by KEEP < FIRE), so a served pass quiets the derivation instead of
// re-firing. The checkpoint's key is the identity it keeps from: cc:<keepFrom>. Its input is the
// span to fold, a projection, so a retried fire summarizes the same span. A crash-looping
// summarizer re-derives the same key and its retries absorb, while a later fire reaches further
// and keys anew.
export const compactionReactor: Reactor<Infer> = (log) => {
  if (!(firedUncovered(log) || (overContext(log) && atRoundBoundary(log)))) return []
  const cut = cutOf(log)
  if (cut === undefined) return []
  const prior = checkpointOf(log)
  const span = log.slice(keepFromIndex(log, prior.keepFrom), cut.index)
  return [
    transition({
      key: `cc:${cut.keepFrom}`,
      input: { keepFrom: cut.keepFrom, summary: prior.summary, span },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const lines = input.span.map(lineOf).filter((l): l is string => l !== null)
          if (lines.length === 0) {
            return [compactionCompleted({ keepFrom: input.keepFrom, summary: input.summary, at })]
          }
          const brief = [
            "Summarize this agent history in a compact paragraph. Keep every fact a future turn could need: names, ids, decisions, unfinished work.",
            input.summary === "" ? "" : `Summary so far: ${input.summary}`,
            lines.join("\n")
          ].join("\n\n")
          const action = yield* (yield* Infer).react(
            [{ type: "MessageReceived", id: `compact-${input.keepFrom}`, text: brief, at }],
            `compact-${input.keepFrom}`
          )
          const summary = action.kind === "complete" ? action.output : input.summary
          return [compactionCompleted({ keepFrom: input.keepFrom, summary, at })]
        })
    })
  ]
}
