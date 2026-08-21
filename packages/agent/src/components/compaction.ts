import { Clock, Effect } from "effect"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { compactionCompleted } from "../events"
import type { Event } from "@clavia/tardigrade-core/event"
import { turnOf, turnView } from "@clavia/tardigrade-code/turns"
import { Infer } from "../runtime/infer"
import type { AgentComponent } from "../runtime/agent"

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

// ContextPolicy is every number that decides how much of the log the model sees: the render's
// truncation caps, the fire and keep lines, and the per-event cap on a summary brief's lines.
// They are one object because the render and the measure must agree; two policies would let a
// consumer raise the render's cap and leave the guard firing against a size no request reaches.
// The same policy therefore goes to the reactor and to the render (request.ts, modelRequest).
export interface ContextPolicy {
  // Chars of one inbound message the render sends; past it the message truncates with a pointer.
  readonly messageRenderCap: number
  // Chars of one tool result the render sends; past it the result truncates.
  readonly resultRenderCap: number
  // Rendered suffix size, in estimated tokens, that fires a compaction pass.
  readonly fireTokens: number
  // Estimated tokens of the tail a pass keeps verbatim. Below fireTokens, which is the
  // hysteresis (module comment).
  readonly keepTokens: number
  // Chars of one event's line in the summary brief a pass sends its summarizer.
  readonly summaryLineCap: number
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  messageRenderCap: 12_000,
  resultRenderCap: 6_000,
  fireTokens: 16_000,
  keepTokens: 4_000,
  summaryLineCap: 200
}

// contextPolicyOf fills an override with the defaults. Every surface that applies context policy
// takes `Partial<ContextPolicy>` and resolves it here, so a caller states only what it changes.
export const contextPolicyOf = (policy: Partial<ContextPolicy> = {}): ContextPolicy => ({
  messageRenderCap: policy.messageRenderCap ?? DEFAULT_CONTEXT_POLICY.messageRenderCap,
  resultRenderCap: policy.resultRenderCap ?? DEFAULT_CONTEXT_POLICY.resultRenderCap,
  fireTokens: policy.fireTokens ?? DEFAULT_CONTEXT_POLICY.fireTokens,
  keepTokens: policy.keepTokens ?? DEFAULT_CONTEXT_POLICY.keepTokens,
  summaryLineCap: policy.summaryLineCap ?? DEFAULT_CONTEXT_POLICY.summaryLineCap
})

// renderedChars counts the characters a render sends for one event: capped where the render
// caps, zero for an event the render skips. The guard must measure the request the model sees;
// a measure over raw event JSON counts tool results the render truncates and lanes the render
// never shows, and fires against a size no request ever reaches.
const renderedChars = (e: Event, policy: ContextPolicy): number => {
  const v = e as Record<string, unknown>
  switch (e.type) {
    case "MessageReceived":
      return Math.min(String(v.text ?? "").length, policy.messageRenderCap)
    case "TextReturned":
      return String(v.text ?? "").length
    case "ToolCalled":
      return JSON.stringify(v.arguments ?? {}).length
    case "ToolReturned":
      return Math.min(JSON.stringify(v.result ?? null).length, policy.resultRenderCap)
    case "OutputRejected":
      // A rejected response and its reasons render while the correction is owed. A projected
      // one (its turn completed) measures high rather than low, which fires the guard early
      // instead of late (request.ts, renderMessages).
      return String(v.text ?? "").length + JSON.stringify(v.errors ?? []).length
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
export const estimateTokens = (events: ReadonlyArray<Event>, policy: Partial<ContextPolicy> = {}): number => {
  const resolved = contextPolicyOf(policy)
  return Math.ceil(events.reduce((n, e) => n + renderedChars(e, resolved), 0) / 4)
}

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
const overContext = (log: ReadonlyArray<Event>, policy: ContextPolicy): boolean =>
  estimateTokens(suffixOf(log), policy) > policy.fireTokens

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
const cutOf = (
  log: ReadonlyArray<Event>,
  policy: ContextPolicy
): { readonly keepFrom: string; readonly index: number } | undefined => {
  const priorIndex = keepFromIndex(log, checkpointOf(log).keepFrom)
  const served = new Set(log.map(turnOf).filter((t): t is string => t !== undefined))
  let tokens = 0
  let raw = priorIndex
  for (let i = log.length - 1; i >= priorIndex; i--) {
    tokens += estimateTokens([log[i]!], policy)
    if (tokens > policy.keepTokens) {
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

// clip cuts one summary line to the policy's cap and says so where it cut. A silent cut reads to
// the summarizer as the whole value, and the summary it writes then states a truncated fact as
// complete.
const clip = (text: string, cap: number): string =>
  text.length > cap ? `${text.slice(0, cap)}…[cut at ${cap} of ${text.length} chars]` : text

const lineOf = (e: Event, policy: ContextPolicy): string | null => {
  const v = e as Record<string, unknown>
  switch (e.type) {
    case "MessageReceived":
      return `user: ${String(v.text ?? "")}`
    case "TextReturned":
      return `agent (working): ${String(v.text ?? "")}`
    case "ToolCalled":
      return `agent ran: ${clip(JSON.stringify(v.arguments ?? {}), policy.summaryLineCap)}`
    case "ToolReturned":
      return `result: ${clip(JSON.stringify(v.result ?? null), policy.summaryLineCap)}`
    case "OutputRejected":
      return `agent (refused, ${String(v.contract ?? "")}): ${clip(String(v.text ?? ""), policy.summaryLineCap)}`
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

// compactionReactorFor derives a pass when the suffix has crossed FIRE at a round boundary, or an
// explicit `CompactionFired` stands uncovered. The act always advances the checkpoint (the
// retained tail is bounded by KEEP < FIRE), so a served pass quiets the derivation instead of
// re-firing. The checkpoint's key is the identity it keeps from: cc:<keepFrom>. Its input is the
// span to fold, a projection, so a retried fire summarizes the same span. A crash-looping
// summarizer re-derives the same key and its retries absorb, while a later fire reaches further
// and keys anew.
//
// The policy this takes must be the one the render takes, or the guard measures a request the
// model never sees (ContextPolicy above).
export const compactionReactorFor = (policy: Partial<ContextPolicy> = {}): Reactor<Infer> => (log) => {
  const resolved = contextPolicyOf(policy)
  if (!(firedUncovered(log) || (overContext(log, resolved) && atRoundBoundary(log)))) return []
  const cut = cutOf(log, resolved)
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
          const lines = input.span.map((e) => lineOf(e, resolved)).filter((l): l is string => l !== null)
          if (lines.length === 0) {
            return [compactionCompleted({ keepFrom: input.keepFrom, summary: input.summary, at })]
          }
          const brief = [
            "Summarize this agent history in a compact paragraph. Keep every fact a future turn could need: names, ids, decisions, unfinished work.",
            input.summary === "" ? "" : `Summary so far: ${input.summary}`,
            lines.join("\n")
          ].join("\n\n")
          // A summarize attempt offers no tools: the only sane action is a completion.
          const action = yield* (yield* Infer).react(
            {
              trajectory: [{ type: "MessageReceived", id: `compact-${input.keepFrom}`, text: brief, at }],
              system: "",
              tools: []
            },
            `compact-${input.keepFrom}`
          )
          const summary = action.kind === "complete" ? action.output : input.summary
          return [compactionCompleted({ keepFrom: input.keepFrom, summary, at })]
        })
    })
  ]
}

// compactionReactor is that reactor on the default policy. An agent on another policy builds its
// own with `compactionReactorFor` and hands the same policy to its render.
export const compactionReactor: Reactor<Infer> = compactionReactorFor()

// compactionFor derives one context contribution and the transitions governed by that policy.
export const compactionFor = (policy: Partial<ContextPolicy>): AgentComponent<Infer> => {
  const reactor = compactionReactorFor(policy)
  return {
    name: "compaction",
    derive: (log) => ({
      view: { system: [], tools: [], context: [{ component: "compaction", policy }], output: [] },
      transitions: reactor(log)
    })
  }
}

export const compaction: AgentComponent<Infer> = compactionFor({})
