import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ModelRef } from "../inference/reference"
import { responsesOf } from "../log/response"

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
  // Selected model context window used to derive the hysteresis lines.
  readonly contextWindowTokens: number
  // Fraction of the selected model window that fires compaction.
  readonly fireRatio: number
  // Fraction of the selected model window retained verbatim after compaction.
  readonly keepRatio: number
  // Rendered suffix size, in estimated tokens, that fires a compaction pass.
  readonly fireTokens: number
  // Estimated tokens of the tail a pass keeps verbatim. Below fireTokens, which is the
  // hysteresis (module comment).
  readonly keepTokens: number
  // Chars of one event's line in the summary brief a pass sends its summarizer.
  readonly summaryLineCap: number
}

export interface CompactionPolicy {
  readonly messageRenderCap: number
  readonly resultRenderCap: number
  readonly fireRatio: number
  readonly keepRatio: number
  readonly summaryLineCap: number
  // model selects the summarizer; omission uses the host default independently of conversation capacity (runtime/composition.test.ts).
  readonly model?: ModelRef
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  messageRenderCap: 12_000,
  resultRenderCap: 6_000,
  fireRatio: 0.8,
  keepRatio: 0.5,
  summaryLineCap: 200
}

const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite positive number, got ${value}`)
  return value
}

const ratio = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`${name} must be between 0 and 1, got ${value}`)
  return value
}

// contextPolicyOf resolves the model-relative policy into the absolute thresholds used by the
// guard and render. The fire and keep lines form one hysteresis policy, so they are validated
// together.
export const contextPolicyOf = (
  policy: Partial<CompactionPolicy>,
  window: number
): ContextPolicy => {
  const contextWindowTokens = positive(window, "contextWindowTokens")
  const fireRatio = ratio(policy.fireRatio ?? DEFAULT_COMPACTION_POLICY.fireRatio, "fireRatio")
  const keepRatio = ratio(policy.keepRatio ?? DEFAULT_COMPACTION_POLICY.keepRatio, "keepRatio")
  if (keepRatio >= fireRatio) throw new Error(`keepRatio must be less than fireRatio, got ${keepRatio} and ${fireRatio}`)
  return {
    messageRenderCap: positive(
      policy.messageRenderCap ?? DEFAULT_COMPACTION_POLICY.messageRenderCap,
      "messageRenderCap"
    ),
    resultRenderCap: positive(
      policy.resultRenderCap ?? DEFAULT_COMPACTION_POLICY.resultRenderCap,
      "resultRenderCap"
    ),
    contextWindowTokens,
    fireRatio,
    keepRatio,
    fireTokens: Math.floor(contextWindowTokens * fireRatio),
    keepTokens: Math.floor(contextWindowTokens * keepRatio),
    summaryLineCap: positive(
      policy.summaryLineCap ?? DEFAULT_COMPACTION_POLICY.summaryLineCap,
      "summaryLineCap"
    )
  }
}

// resolvedContextPolicyOf fills a partial absolute policy at the render boundary. Components
// normally contribute every field after resolving their model-relative policy.
export const resolvedContextPolicyOf = (policy: Partial<ContextPolicy> = {}): ContextPolicy => {
  const defaults = { ...DEFAULT_COMPACTION_POLICY, contextWindowTokens: Infinity, fireTokens: Infinity, keepTokens: Infinity }
  return {
    messageRenderCap: policy.messageRenderCap ?? defaults.messageRenderCap,
    resultRenderCap: policy.resultRenderCap ?? defaults.resultRenderCap,
    contextWindowTokens: policy.contextWindowTokens ?? defaults.contextWindowTokens,
    fireRatio: policy.fireRatio ?? defaults.fireRatio,
    keepRatio: policy.keepRatio ?? defaults.keepRatio,
    fireTokens: policy.fireTokens ?? defaults.fireTokens,
    keepTokens: policy.keepTokens ?? defaults.keepTokens,
    summaryLineCap: policy.summaryLineCap ?? defaults.summaryLineCap
  }
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
export const keepFromIndex = (
  events: ReadonlyArray<Event>,
  keepFrom: string,
  responses?: ReturnType<typeof responsesOf>
): number => {
  if (keepFrom === "") return 0
  const indexed = responses ?? responsesOf(events)
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const v = e as { callId?: unknown; id?: unknown }
    if (keepFrom.startsWith("c:") && e.type === "ToolCalled" && JSON.stringify([e.turn ?? null, v.callId]) === keepFrom.slice(2)) {
      const first = indexed.firstCalls.get(e)!
      const response = events.findIndex((event) => event.type === "ModelReturned" && event.continuation !== undefined &&
        event.callId === first.responseId && event.turn === first.turn && (event.epoch ?? 0) === (first.epoch ?? 0))
      return response < 0 ? events.indexOf(first) : response
    }
    if (keepFrom.startsWith("m:") && e.type === "MessageReceived" && String(v.id) === keepFrom.slice(2)) return i
  }
  return 0
}

// suffixOf returns everything after the checkpoint: the span a render or a fire decision sees.
export const suffixOf = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.slice(keepFromIndex(log, checkpointOf(log).keepFrom))
