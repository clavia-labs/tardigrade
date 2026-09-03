import type { Event } from "@clavia/tardigrade-core/log/event"
import { replayProjection, type Projection } from "@clavia/tardigrade-core/projection"
import { terminalReportOutcomeOf } from "@clavia/tardigrade-core/communication/message"
import { checkpointOf, keepFromIndex, resolvedContextPolicyOf, type ContextPolicy } from "../component/compaction"
import {
  correctionText,
  modeOf
} from "../output/contract"
import { transcriptProjection, type TranscriptProjectionState } from "./transcript"

export interface AgentToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface AgentMessage {
  readonly role: "user" | "assistant" | "tool"
  readonly content: string | null
  readonly toolCalls?: ReadonlyArray<AgentToolCall>
  readonly toolCallId?: string
}

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
  const text = String(value.text ?? "")
  const rendered = text.length > policy.messageRenderCap
    ? `${text.slice(0, policy.messageRenderCap)}…[truncated at ${policy.messageRenderCap} of ${text.length} chars; read the full message with logs.events on this facet, id ${String(value.id)}]`
    : text
  const report = terminalReportOutcomeOf(value)
  return {
    role: "user",
    content: report === undefined
      ? rendered
      : `[Terminal report: ${report}. Your answer to this report stays in this thread and is not sent back to its sender.]\n${rendered}`
  }
}

const messagesFrom = (
  projected: ReadonlyArray<Event>,
  resolved: ContextPolicy
): ReadonlyArray<AgentMessage> => {
  const messages: AgentMessage[] = []
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
  if (openHead !== -1 && openHead < from) messages.push(userMessageOf(projected[openHead]!, resolved))
  if (checkpoint.summary !== "") messages.push({ role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` })
  let pendingText: string | null = null
  for (const event of projected.slice(from)) {
    const value = event as Record<string, unknown>
    switch (event.type) {
      case "MessageReceived":
        messages.push(userMessageOf(event, resolved))
        break
      case "TextReturned":
        pendingText = String(value.text ?? "")
        break
      case "ToolCalled":
        messages.push({
          role: "assistant",
          content: pendingText,
          toolCalls: [{
            id: String(value.callId),
            name: String(value.name),
            arguments: JSON.stringify(value.arguments ?? {})
          }]
        })
        pendingText = null
        break
      case "ToolReturned": {
        const body = JSON.stringify(value.result ?? null)
        messages.push({
          role: "tool",
          toolCallId: String(value.callId),
          content: body.length > resolved.resultRenderCap
            ? `${body.slice(0, resolved.resultRenderCap)}…[truncated at ${resolved.resultRenderCap} of ${body.length} chars]`
            : body
        })
        break
      }
      case "OutputRejected": {
        messages.push({ role: "assistant", content: String(value.text ?? "") })
        const feedback = feedbackFor(value, decided)
        if (feedback !== undefined) messages.push({ role: "user", content: feedback })
        break
      }
      case "TurnCompleted":
        messages.push({ role: "assistant", content: String(value.output ?? "") })
        break
      case "TurnFailed":
        messages.push({ role: "assistant", content: `the turn failed: ${String(value.error ?? "")}` })
        break
      case "TurnCancelled": {
        const reason = String(value.reason ?? "")
        messages.push({
          role: "assistant",
          content: reason === "" ? "the turn was cancelled" : `the turn was cancelled: ${reason}`
        })
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
    output: (state) => messagesFrom(transcript.output(state.transcript).events, resolved)
  }
}

// renderMessages replays the model message projection over complete history.
export const renderMessages = (
  trajectory: ReadonlyArray<Event>,
  policy: Partial<ContextPolicy> = {}
): ReadonlyArray<AgentMessage> => replayProjection(messagesProjection(policy), trajectory)
