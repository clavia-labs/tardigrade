import { ModelLock } from "@clavia/tardigrade-model/lock"
import type { Context } from "effect"
import { resolvedContextPolicyOf, checkpointOf, keepFromIndex, type ContextPolicy, type CompactionPolicy, DEFAULT_COMPACTION_POLICY } from "./context"
export { contextPolicyOf, resolvedContextPolicyOf, checkpointOf, keepFromIndex, suffixOf, DEFAULT_COMPACTION_POLICY, type ContextPolicy, type CompactionPolicy } from "./context"
import { MessageContent, type MessageContentPart } from "../../log/message"
import { resolveMessageObjects } from "../../model/execution/objects"
import { historyOf } from "../../model/execution/prompt"
import { estimateTokens, renderedWeights, conversationModelOf } from "../../projection/tokens"
export { estimateTokens } from "../../projection/tokens"
import { upcastError } from "../../log/upcast"
import { hasUnansweredToolCall, responsesOf } from "../../log/response"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"
import { Clock, Effect, Schema } from "effect"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { compactionCompleted } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnOf, turnView } from "@clavia/tardigrade-code/execution/turns"
import { component } from "@clavia/tardigrade-core/actor"
import { projectedOutput } from "../../projection/transcript"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import { summarize } from "./model"
import { BindingSettings, modelSettingsFor } from "@clavia/tardigrade-model/settings"
import type { ModelRef } from "../../model/reference"
import type { AgentComponent, AgentView } from "../view"
import { messages } from "../messages"

// compaction proposals preserve complete tool exchanges and checkpoint ownership (compact.properties.test.ts).
// Infer selects them against its model capacity; committed summaries transform the conversation view.

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
  model = conversationModelOf(log)
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

// compactionTransition checkpoints a nonempty summary and leaves failed cuts available for recovery (integration/compact.test.ts).
// The resolved policy must also govern rendering so the cut measures the visible history.
const compactionTransition = (
  resolved: ContextPolicy,
  model: ModelRef,
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
        model,
        keepTokens: resolved.keepTokens,
        fileTokens: resolved.fileTokens
      },
      act: (input) =>
        Effect.gen(function* () {
          const self = yield* Self
          const at = yield* Clock.currentTimeMillis
          const content: MessageContentPart[] = []
          for (const event of input.span) {
            if (event.type === "MessageReceived" && event.content !== undefined) {
              const parts = yield* Schema.decodeUnknownEffect(MessageContent)(event.content).pipe(Effect.orDie)
              content.push({ type: "text", text: "user:\n" }, ...parts, { type: "text", text: "\n" })
            } else {
              const line = lineOf(event, resolved)
              if (line !== null) content.push({ type: "text", text: line + "\n" })
            }
          }
          if (content.length === 0) {
            return [compactionCompleted({
              keepFrom: input.keepFrom,
              summary: input.summary,
              keepTokens: input.keepTokens,
              fileTokens: input.fileTokens,
              at
            })]
          }
          const brief = [{
            role: "user" as const,
            content: [
              { type: "text" as const, text: "Summarize this agent history in a compact paragraph. Keep every fact a future turn could need: names, ids, decisions, unfinished work. Preserve relevant facts from attached files.\n\n" },
              ...(input.summary === "" ? [] : [{ type: "text" as const, text: `Summary so far: ${input.summary}\n\n` }]),
              ...content
            ]
          }]
          // A summarize attempt offers no tools: the only sane action is a completion.
          const summaryModel = input.model
          const settings = yield* modelSettingsFor(summaryModel)
          const objects = yield* resolveMessageObjects(brief).pipe(Effect.orDie)
          const prompt = Prompt.fromMessages(historyOf(brief, {
            provider: settings.provider, protocol: settings.protocol, model: settings.model
          }, objects))
          const summary = yield* summarize(prompt, { ...self, turn: `compact-${input.keepFrom}` }, summaryModel).pipe(
            Effect.provideService(BindingSettings, settings),
            Effect.orDie
          )
          return [compactionCompleted({
            keepFrom: input.keepFrom,
            summary,
            keepTokens: input.keepTokens,
            fileTokens: input.fileTokens,
            model: summaryModel,
            at
          })]
        })
    })
  ]

// CompactOptions controls how much existing conversation to retain and how to summarize the rest.
export type CompactOptions = Partial<Pick<CompactionPolicy,
  "messageRenderCap" | "resultRenderCap" | "fileTokens" | "triggerRatio" | "fireRatio" | "retainRatio" | "keepRatio" | "summaryLineCap" | "model"
>>

const retainRatioOf = (options: CompactOptions): number => {
  if (options.retainRatio !== undefined && options.keepRatio !== undefined && options.retainRatio !== options.keepRatio) {
    throw new Error("retainRatio conflicts with deprecated keepRatio")
  }
  const ratio = options.retainRatio ?? options.keepRatio ?? DEFAULT_COMPACTION_POLICY.retainRatio
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error("retainRatio must be between 0 and 1")
  return ratio
}

// compactionReactor proposes a smaller conversation at a complete round boundary; the parent decides when to run it.
export const compactionReactor = (options: CompactOptions, lock: Context.Service.Shape<typeof ModelLock>): CompleteTransitionDerivation<LanguageModel.LanguageModel | Self> => (history) => {
  const log = history.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  const view = projectedOutput(log)
  if (!atRoundBoundary(view)) return []
  const active = conversationModelOf(view)
  const resolved = resolvedContextPolicyOf({ ...options, keepRatio: retainRatioOf(options) })
  const policy = { ...resolved, keepTokens: Math.floor(estimateTokens(view, resolved, active) * resolved.keepRatio) }
  const cut = cutOf(view, policy, undefined, active)
  if (cut === undefined) return []
  const prior = checkpointOf(view)
  return compactionTransition(policy, lock.resolve(options.model).model, prior.summary, cut.keepFrom,
    view.slice(cut.priorIndex, cut.index), view[cut.index]!)
}

// compact transforms the conversation with committed summaries and offers optional compaction work to its parent.
export const compact = <R>(
  child: AgentComponent<R>,
  options: CompactOptions = {}
): AgentComponent<R | LanguageModel.LanguageModel | Self | ModelLock> => {
  const retainRatio = retainRatioOf(options)
  if (options.triggerRatio !== undefined && options.fireRatio !== undefined && options.triggerRatio !== options.fireRatio) {
    throw new Error("triggerRatio conflicts with deprecated fireRatio")
  }
  const triggerRatio = options.triggerRatio ?? options.fireRatio ?? DEFAULT_COMPACTION_POLICY.triggerRatio
  if (!Number.isFinite(triggerRatio) || triggerRatio <= 0 || triggerRatio >= 1) throw new Error("triggerRatio must be between 0 and 1")
  return component<Context.Service.Shape<typeof ModelLock>, AgentView, R | LanguageModel.LanguageModel | Self, never, typeof child, readonly [typeof ModelLock]>({
    name: "compaction",
    children: child,
    dependencies: [ModelLock],
    initial: (_children, [lock]) => lock,
    step: (state) => state,

    output: (lock, bound) => {
      const output = bound.output()
      const conversation = output.view.messages?.[0]
      if (conversation === undefined || output.view.messages?.length !== 1)
        throw new Error("compact requires one conversation view")
      const policy = { ...conversation.context, ...options, retainRatio }
      const resolved = resolvedContextPolicyOf(policy)
      const context = {
        ...conversation.context,
        messageRenderCap: resolved.messageRenderCap,
        resultRenderCap: resolved.resultRenderCap,
        fileTokens: resolved.fileTokens,
        summaryLineCap: resolved.summaryLineCap,
        keepRatio: retainRatio
      }
      const proposals = conversation.ready ? compactionReactor(policy, lock)(conversation.trajectory) : []
      return {
        view: {
          ...output.view, messages: [{
            ...conversation, component: "compact", context,
            checkpoint: checkpointOf(conversation.trajectory),
            compaction: {
              proposals: proposals.map(proposal => proposal.key),
              triggerRatio
            }
          }]
        },
        transitions: [...output.transitions, ...proposals],
        interactions: {
          cancel: (cancellation) => bound.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
}

/** @deprecated Use compact(messages(), options). */
export const compaction = (options: CompactOptions = {}): ReturnType<typeof compact<never>> =>
  compact(messages(), options)
