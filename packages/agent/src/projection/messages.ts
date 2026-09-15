import { Schema } from "effect"
import { MessageContent } from "../log/message"
import { responseKeyOf, upcastError } from "../log/upcast"
import type { ProviderContinuation } from "../inference/continuation"
import { responsesOf } from "../log/response"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { replayProjection, type Projection } from "@clavia/tardigrade-core/projection"
import { terminalReportOutcomeOf } from "@clavia/tardigrade-core/interaction/provider-message"
import { checkpointOf, keepFromIndex, resolvedContextPolicyOf, type ContextPolicy } from "../component/context"
import {
  correctionText,
  modeOf
} from "../output/contract"
import { projectedOutput, transcriptProjection, type TranscriptProjectionState } from "./transcript"

export interface AgentToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

interface AgentMessageMetadata {
  readonly continuation?: ProviderContinuation
  readonly toolCalls?: ReadonlyArray<AgentToolCall>
  readonly toolCallId?: string
  readonly isFailure?: boolean
}

export type AgentMessage = AgentMessageMetadata & (
  | { readonly role: "user"; readonly content: string | MessageContent }
  | { readonly role: "assistant" | "tool"; readonly content: string | null }
)

const feedbackFor = (
  rejection: Record<string, unknown>,
  decided: ReadonlyMap<string, string>
): string | undefined => {
  const decision = decided.get(String(rejection["attempt"]))
  if (decision !== undefined) return decision
  const mode = modeOf(rejection["mode"])
  if (mode?.kind !== "repair") return undefined
  return correctionText((rejection["errors"] ?? []) as ReadonlyArray<string>)
}

const userMessageOf = (event: Event, policy: ContextPolicy): AgentMessage => {
  const value = event as Record<string, unknown>
  const report = terminalReportOutcomeOf(value)
  const reportText = report === undefined ? undefined
    : `[Terminal report: ${report}. Your answer to this report stays in this thread and is not sent back to its sender.]\n`
  if (value.content !== undefined) {
    if (!Schema.is(MessageContent)(value.content)) return { role: "user", content: "[Invalid message content]" }
    const total = value.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0)
    let remaining = policy.messageRenderCap
    let noticed = false
    const content = value.content.map((part) => {
      if (part.type === "file") return part
      const kept = part.text.slice(0, remaining)
      remaining -= kept.length
      const notice = kept.length < part.text.length && !noticed
        ? `…[truncated at ${policy.messageRenderCap} of ${total} chars]` : ""
      if (notice !== "") noticed = true
      return { ...part, text: kept + notice }
    })
    return { role: "user", content: reportText === undefined ? content : [{ type: "text", text: reportText }, ...content] }
  }
  const text = String(value.text ?? "")
  const rendered = text.length > policy.messageRenderCap
    ? `${text.slice(0, policy.messageRenderCap)}…[truncated at ${policy.messageRenderCap} of ${text.length} chars; read the full message with logs.events on this facet, id ${String(value.id)}]`
    : text
  return {
    role: "user",
    content: reportText === undefined ? rendered : reportText + rendered
  }
}

export interface RenderedMessageEntry {
  readonly event: Event
  readonly message: AgentMessage
}

const messageEntriesFrom = (
  projected: ReadonlyArray<Event>,
  resolved: ContextPolicy
): ReadonlyArray<RenderedMessageEntry> => {
  const messages: RenderedMessageEntry[] = []
  const push = (event: Event, message: AgentMessage) => messages.push({ event, message })
  const checkpoint = checkpointOf(projected)
  const from = keepFromIndex(projected, checkpoint.keepFrom)
  const terminated = new Set(
    projected
      .filter((event) => event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled")
      .map((event) => String((event as { turn?: unknown }).turn))
  )
  const decided = new Map(
    projected
      .filter((event) => event.type === "OutputRetryRequested")
      .map((event) => [
        String((event as { rejection?: unknown }).rejection),
        String((event as { feedback?: unknown }).feedback)
      ])
  )
  const openHead = projected.findIndex(
    (event) => event.type === "MessageReceived" && !terminated.has(String((event as { id?: unknown }).id))
  )
  if (openHead !== -1 && openHead < from) push(projected[openHead]!, userMessageOf(projected[openHead]!, resolved))
  if (checkpoint.summary !== "") push(projected.findLast((event) => event.type === "CompactionCompleted")!, { role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` })
  const responses = responsesOf(projected)
  const batches = new Map<string, AgentToolCall[]>()
  const callOf = (event: Event): AgentToolCall => ({
    id: String(event.callId),
    name: String(event.name),
    arguments: JSON.stringify(event.arguments ?? {})
  })
  for (const event of projected.slice(from)) {
    const key = responses.keys.get(event)
    if (event.type !== "ToolCalled" || key === undefined) continue
    const calls = batches.get(key) ?? []
    calls.push(callOf(event))
    batches.set(key, calls)
  }
  const emitted = new Set<string>()
  const pendingText = new Map<unknown, string>()
  const closed = new Set<unknown>()
  let currentTurn: unknown
  const continuations = new Map(projected.filter((event) => event.type === "ModelReturned" && event.continuation !== undefined)
    .map((event) => [responseKeyOf(event, event.callId), event.continuation as ProviderContinuation]))
  const continuationOf = (event: Event, id: unknown) => {
    const continuation = id === undefined ? undefined : continuations.get(responseKeyOf(event, id))
    return continuation === undefined ? {} : { continuation }
  }
  for (const [index, event] of projected.entries()) {
    if (event.type === "MessageReceived") currentTurn = event.id
    if (index < from) continue
    // turn falls back to the preceding ingress for historical events (request.test.ts).
    const turn = event.turn ?? currentTurn
    const value = event as Record<string, unknown>
    switch (event.type) {
      case "MessageReceived":
      case "TurnResumed":
        pendingText.delete(turn)
        closed.delete(turn)
        if (event.type === "TurnResumed") break
        push(event, userMessageOf(event, resolved))
        break
      case "ModelCalled":
        pendingText.delete(turn)
        break
      case "TextReturned":
        if (!closed.has(turn)) pendingText.set(turn, String(value.text ?? ""))
        break
      case "ToolCalled": {
        const key = responses.keys.get(event)
        if (key !== undefined && emitted.has(key)) break
        if (key !== undefined) emitted.add(key)
        push(event, {
          role: "assistant",
          content: pendingText.get(turn) ?? null,
          ...continuationOf(event, value.responseId),
          toolCalls: key === undefined ? [callOf(event)] : batches.get(key)!
        })
        pendingText.delete(turn)
        break
      }
      case "ToolReturned": {
        const body = JSON.stringify(value.result ?? null)
        push(event, {
          role: "tool",
          toolCallId: String(value.callId),
          ...(value.isFailure === true ? { isFailure: true } : {}),
          content: body.length > resolved.resultRenderCap
            ? `${body.slice(0, resolved.resultRenderCap)}…[truncated at ${resolved.resultRenderCap} of ${body.length} chars]`
            : body
        })
        break
      }
      case "OutputRejected": {
        push(event, { role: "assistant", content: String(value.text ?? ""), ...continuationOf(event, value.attempt) })
        const feedback = feedbackFor(value, decided)
        if (feedback !== undefined) push(event, { role: "user", content: feedback })
        break
      }
      case "TurnCompleted":
        pendingText.delete(turn)
        closed.add(turn)
        push(event, { role: "assistant", content: String(value.output ?? ""), ...continuationOf(event, value.attemptKey) })
        break
      case "TurnFailed":
        pendingText.delete(turn)
        closed.add(turn)
        push(event, { role: "assistant", content: `the turn failed: ${upcastError(value.error).message}` })
        break
      case "TurnCancelled": {
        const reason = String(value.reason ?? "")
        closed.add(turn)
        push(event, {
          role: "assistant",
          content: pendingText.get(turn) ?? (reason === "" ? "the turn was cancelled" : `the turn was cancelled: ${reason}`)
        })
        pendingText.delete(turn)
        break
      }
      default:
        break
    }
  }
  return messages
}

// MessagesProjectionState retains the incremental transcript state hidden behind the model message view.
export interface MessagesProjectionState {
  readonly transcript: TranscriptProjectionState
}

// messagesProjection constructs the event-history to model-message projection under one visible context policy.
export const messagesProjection = (
  policy: Partial<ContextPolicy> = {}
): Projection<MessagesProjectionState, ReadonlyArray<AgentMessage>> => {
  const resolved = resolvedContextPolicyOf(policy)
  const transcript = transcriptProjection()
  return {
    initial: () => ({ transcript: transcript.initial() }),
    step: (state, event) => ({ transcript: transcript.step(state.transcript, event) }),
    output: (state) => messageEntriesFrom(transcript.output(state.transcript).events, resolved).map((entry) => entry.message)
  }
}

// renderMessages replays the model message projection over complete history.
export const renderMessages = (
  trajectory: ReadonlyArray<Event>,
  policy: Partial<ContextPolicy> = {}
): ReadonlyArray<AgentMessage> => replayProjection(messagesProjection(policy), trajectory)

// renderMessageEntries retains message ownership for compaction cuts (component/compaction.properties.test.ts).
export const renderMessageEntries = (trajectory: ReadonlyArray<Event>, policy: Partial<ContextPolicy> = {}): ReadonlyArray<RenderedMessageEntry> =>
  messageEntriesFrom(projectedOutput(trajectory), resolvedContextPolicyOf(policy))
