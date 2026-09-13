import { contextPolicyOf, resolvedContextPolicyOf, checkpointOf, keepFromIndex, type ContextPolicy, type CompactionPolicy, DEFAULT_COMPACTION_POLICY } from "./context"
export { contextPolicyOf, resolvedContextPolicyOf, checkpointOf, keepFromIndex, suffixOf, DEFAULT_COMPACTION_POLICY, type ContextPolicy, type CompactionPolicy } from "./context"
import { replayOf } from "../inference/model/continuation"
import { renderMessageEntries } from "../projection/messages"
import { upcastError } from "../log/upcast"
import { hasUnansweredToolCall, responsesOf } from "../log/response"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"
import { Clock, Effect, HashSet } from "effect"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { compactionCompleted } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import { component } from "@clavia/tardigrade-core/actor"
import {
  projectedOutput,
  transcriptProjection,
  type TranscriptProjectionState
} from "../projection/transcript"
import { LanguageModel } from "effect/unstable/ai"
import { summarize } from "./compaction/model"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { modelRefOf, type ModelRef } from "../inference/reference"
import type { AgentComponent } from "../runtime/composition"

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

// selectedModelOf returns the open turn's explicit selection or the latest model actually called.
const selectedModelOf = (log: ReadonlyArray<Event>): ModelRef | undefined => {
  const open = turnView(log)
  const requested = open.length > 0 ? modelRefOf((open[0] as { readonly model?: unknown }).model) : undefined
  if (requested !== undefined) return requested
  const called = (open.length > 0 ? open : log).findLast((event) => event.type === "ModelCalled") as { readonly model?: unknown } | undefined
  return modelRefOf(called?.model)
}

const contextPolicyFrom = (
  log: ReadonlyArray<Event>,
  policy: Partial<CompactionPolicy>,
  window: number
): ContextPolicy => contextPolicyOf(policy, window)

// renderedWeights measures projected messages at their owning events; an unresolved protocol conservatively retains native state (compaction.properties.test.ts).
const renderedWeights = (events: ReadonlyArray<Event>, policy: ContextPolicy, model: ModelRef | undefined): ReadonlyMap<Event, number> => {
  const weights = new Map<Event, number>()
  for (const { event, message } of renderMessageEntries(events, policy)) {
    const continuation = message.continuation
    const replay = continuation === undefined ? undefined : replayOf(continuation, model === undefined ? continuation : { ...continuation, provider: model.provider, model: model.model_id })
    const chars = replay === undefined
      ? (message.content?.length ?? 0) + (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0)
      : JSON.stringify(continuation!.payload).length
    weights.set(event, (weights.get(event) ?? 0) + chars)
  }
  return weights
}

// estimateTokens estimates projected context as characters over four (compaction.properties.test.ts).
export const estimateTokens = (events: ReadonlyArray<Event>, policy: Partial<ContextPolicy> = {}, model = selectedModelOf(events)): number =>
  Math.ceil([...renderedWeights(events, resolvedContextPolicyOf(policy), model).values()].reduce((sum, weight) => sum + weight, 0) / 4)

// overContext reports whether the suffix has passed FIRE tokens. It is pure and total over the
// log, so the fire decision re-folds identically on replay: it reads only the log, no clock and
// no random source.
const overContext = (log: ReadonlyArray<Event>, policy: ContextPolicy, model: ModelRef | undefined): boolean =>
  estimateTokens(log, policy, model) > policy.fireTokens

// atRoundBoundary gates the guard: a pass may land whenever the open turn awaits no tool call,
// between turns included. A checkpoint landing mid-round would cut a call from the return the
// world still owes it.
const atRoundBoundary = (log: ReadonlyArray<Event>): boolean => {
  const open = turnView(log)
  return open.length === 0 || !hasUnansweredToolCall(open)
}

// boundaryIdOf returns the identity a cut at this event would record: a ToolCalled keeps its
// return beside it, and a served head opens its turn whole. Any other position splits a pair or
// names an event the projection cannot see, so it is no boundary.
const boundaryIdOf = (e: Event, served: ReadonlySet<string>, firstCalls: ReadonlyMap<Event, Event>): string | undefined => {
  const v = e as { callId?: unknown; id?: unknown }
  if (e.type === "ToolCalled" && firstCalls.get(e) === e) return `c:${JSON.stringify([e.turn ?? null, v.callId])}`
  if (e.type === "MessageReceived" && served.has(String(v.id))) return `m:${String(v.id)}`
  return undefined
}

// cutOf picks the next checkpoint: the newest boundary whose tail still fits KEEP, or failing
// that the first boundary past the KEEP line, so the checkpoint always advances when a boundary
// exists at all. The checkpoint never moves backward; no boundary past the prior one means no
// cut, and the fire waits for the next round to offer one.
const cutOf = (
  log: ReadonlyArray<Event>,
  policy: ContextPolicy,
  knownServed?: ReadonlySet<string>,
  model = selectedModelOf(log)
): { readonly keepFrom: string; readonly index: number; readonly priorIndex: number } | undefined => {
  const responses = responsesOf(log)
  const firstCalls = responses.firstCalls
  const priorIndex = keepFromIndex(log, checkpointOf(log).keepFrom, responses)
  const served = new Set(knownServed ?? log.map(turnOf).filter((t): t is string => t !== undefined))
  const current = turnView(log)[0]
  if (current?.type === "MessageReceived") served.add(String(current.id))
  const weights = renderedWeights(log, policy, model)
  let chars = 0
  let raw = priorIndex
  for (let i = log.length - 1; i >= priorIndex; i--) {
    chars += weights.get(log[i]!) ?? 0
    if (Math.ceil(chars / 4) > policy.keepTokens) {
      raw = i + 1
      break
    }
  }
  for (let i = Math.min(raw, log.length - 1); i > priorIndex; i--) {
    const id = boundaryIdOf(log[i]!, served, firstCalls)
    if (id !== undefined) {
      const index = keepFromIndex(log, id, responses)
      if (index > priorIndex) return { keepFrom: id, index, priorIndex }
    }
  }
  for (let i = Math.max(raw + 1, priorIndex + 1); i < log.length; i++) {
    const id = boundaryIdOf(log[i]!, served, firstCalls)
    if (id !== undefined) {
      const index = keepFromIndex(log, id, responses)
      if (index > priorIndex) return { keepFrom: id, index, priorIndex }
    }
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
    case "OutputRetryRequested":
      return `asked again: ${clip(String(v.feedback ?? ""), policy.summaryLineCap)}`
    case "TurnCompleted":
      return `agent: ${String(v.output ?? "")}`
    case "TurnFailed":
      return `failed: ${upcastError(v.error).message}`
    case "TurnCancelled":
      return `cancelled${v.reason === undefined ? "" : `: ${String(v.reason)}`}`
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

// compactionTransition checkpoints a nonempty summary and leaves failed cuts available for recovery (compaction.test.ts).
// The resolved policy must also govern rendering so the cut measures the visible history.
const compactionTransition = (
  resolved: ContextPolicy,
  model: ModelRef | undefined,
  summary: string,
  keepFrom: string,
  span: ReadonlyArray<Event>,
  owner: Event
): ReadonlyArray<Transition<never, LanguageModel.LanguageModel | Self>> => [
    bindTransitionContext(owner, "compaction").effect("summarize", {
      invocation: null,
      input: {
        keepFrom,
        summary,
        span,
        ...(model === undefined ? {} : { model }),
        contextWindowTokens: resolved.contextWindowTokens,
        fireTokens: resolved.fireTokens,
        keepTokens: resolved.keepTokens
      },
      act: (input) =>
        Effect.gen(function* () {
          const self = yield* Self
          const at = yield* Clock.currentTimeMillis
          const lines = input.span.map((e) => lineOf(e, resolved)).filter((l): l is string => l !== null)
          if (lines.length === 0) {
            return [compactionCompleted({
              keepFrom: input.keepFrom,
              summary: input.summary,
              contextWindowTokens: input.contextWindowTokens,
              fireTokens: input.fireTokens,
              keepTokens: input.keepTokens,
              at
            })]
          }
          const brief = [
            "Summarize this agent history in a compact paragraph. Keep every fact a future turn could need: names, ids, decisions, unfinished work.",
            input.summary === "" ? "" : `Summary so far: ${input.summary}`,
            lines.join("\n")
          ].join("\n\n")
          // A summarize attempt offers no tools: the only sane action is a completion.
          const selection = yield* ModelSelection
          const summaryModel = selection.resolve?.(input.model).model ?? input.model
          const summary = yield* summarize(brief, { ...self, turn: `compact-${input.keepFrom}` }, summaryModel).pipe(
            Effect.provideService(BindingSettings, yield* (selection.settings?.(summaryModel) ?? BindingSettings)),
            Effect.orDie
          )
          return [compactionCompleted({
            keepFrom: input.keepFrom,
            summary,
            contextWindowTokens: input.contextWindowTokens,
            fireTokens: input.fireTokens,
            keepTokens: input.keepTokens,
            ...(summaryModel === undefined ? {} : { model: summaryModel }),
            at
          })]
        })
    })
  ]

export const compactionReactor = (policy: Partial<CompactionPolicy>, window: number, selected?: ModelRef): CompleteTransitionDerivation<LanguageModel.LanguageModel | Self> => (history) => {
  const log = history.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  const active = selected ?? selectedModelOf(log)
  const model = policy.model
  const resolved = contextPolicyFrom(log, policy, window)
  // The projection runs first, so the guard, the cut, and the brief all read the history the
  // model reads. A corrected exchange the render hides can neither trigger a paid pass nor leak
  // its rejected reply into a summary (src/projection/transcript.ts, projectedOutput).
  const view = projectedOutput(log)
  if (!(firedUncovered(view) || (overContext(view, resolved, active) && atRoundBoundary(view)))) return []
  const cut = cutOf(view, resolved, undefined, active)
  if (cut === undefined) return []
  const prior = checkpointOf(view)
  const span = view.slice(cut.priorIndex, cut.index)
  return compactionTransition(resolved, model, prior.summary, cut.keepFrom, span, view[cut.index]!)
}

// compactionWithWindow derives context and checkpoints from resolved model capacity (compaction.properties.test.ts).
export const compactionWithWindow = (policy: Partial<CompactionPolicy>, window: number, active?: ModelRef): AgentComponent<LanguageModel.LanguageModel | Self> => {
  interface State {
    readonly turns: TurnProjectionState
    readonly transcript: TranscriptProjectionState
    readonly served: HashSet.HashSet<string>
    readonly checkpoint: { readonly keepFrom: string; readonly summary: string }
    readonly fires: number
    readonly passes: number
    readonly lastModel?: ModelRef
  }
  const transcript = transcriptProjection()
  const initial = (): State => ({
    turns: initialTurnProjection(),
    transcript: transcript.initial(),
    served: HashSet.empty(),
    checkpoint: { keepFrom: "", summary: "" },
    fires: 0,
    passes: 0
  })
  const transcriptFrom = (events: Iterable<Event>): TranscriptProjectionState => {
    let state = transcript.initial()
    for (const event of events) state = transcript.step(state, event)
    return state
  }
  const retainedTranscript = (events: ReadonlyArray<Event>, keepFrom: string): TranscriptProjectionState => {
    const from = keepFromIndex(events, keepFrom)
    const visible = new Set(renderMessageEntries(events).map((entry) => entry.event))
    return transcriptFrom(events.filter((event, index) => index >= from || visible.has(event)))
  }
  const reduce = (state: State, event: Event): State => {
    const completed = event.type === "CompactionCompleted"
    const projected = transcript.step(state.transcript, event)
    const nextCheckpoint = completed
      ? {
          keepFrom: String((event as { readonly keepFrom?: unknown }).keepFrom ?? ""),
          summary: String((event as { readonly summary?: unknown }).summary ?? "")
        }
      : state.checkpoint
    const projectedEvents = completed ? transcript.output(projected).events : undefined
    const retained = completed
      ? retainedTranscript(projectedEvents!, nextCheckpoint.keepFrom)
      : projected
    const servedTurn = turnOf(event)
    const model = event.type === "ModelCalled"
      ? modelRefOf((event as { readonly model?: unknown }).model) ?? state.lastModel
      : state.lastModel
    return {
      turns: reduceTurnProjection(state.turns, event),
      transcript: retained,
      served: servedTurn === undefined ? state.served : HashSet.add(state.served, servedTurn),
      checkpoint: nextCheckpoint,
      fires: state.fires + (event.type === "CompactionFired" ? 1 : 0),
      passes: state.passes + (completed ? 1 : 0),
      ...(model === undefined ? {} : { lastModel: model })
    }
  }
  const transitions = (state: State, resolved: ContextPolicy, model: ModelRef | undefined, selected: ModelRef | undefined) => {
    const transcriptOutput = transcript.output(state.transcript)
    const overFireLine = estimateTokens(transcriptOutput.events, resolved, selected) > resolved.fireTokens
    if (!(state.fires > state.passes || (overFireLine && atRoundBoundary(turnViewFrom(state.turns))))) return []
    const suffix = transcriptOutput.events
    const cut = cutOf(suffix, resolved, new Set(state.served), selected)
    if (cut === undefined) return []
    const prior = checkpointOf(suffix)
    const span = suffix.slice(cut.priorIndex, cut.index)
    return compactionTransition(resolved, model, prior.summary, cut.keepFrom, span, suffix[cut.index]!)
  }
  return component({
    name: "compaction",
    initial,
    step: reduce,
    output: (state) => {
      const open = turnViewFrom(state.turns)
      const selected = active ?? (open.length > 0 ? selectedModelOf(open) : state.lastModel)
      const model = policy.model
      const resolved = contextPolicyOf(policy, window)
      return {
        view: {
          system: [],
          tools: [],
          context: [{ component: "compaction", policy: resolved }],
          output: []
        },
        transitions: transitions(state, resolved, model, selected)
      }
    }
  })
}

// compaction prepares conversation history using the active model capacity (runtime/composition.test.ts).
export const compaction = (policy: Partial<CompactionPolicy> = {}): AgentComponent => component({
  name: "compaction",
  initial: () => undefined,
  step: (state) => state,
  output: () => ({
    view: { system: [], tools: [], context: [{ component: "compaction", policy: {
      messageRenderCap: policy.messageRenderCap ?? DEFAULT_COMPACTION_POLICY.messageRenderCap, resultRenderCap: policy.resultRenderCap ?? DEFAULT_COMPACTION_POLICY.resultRenderCap
    }, compaction: policy }], output: [] },
    transitions: []
  })
})
