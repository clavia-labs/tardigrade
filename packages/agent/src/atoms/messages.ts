import { Schema } from "effect"
import { ResolutionResult, isMessageReceived } from "@clavia/tardigrade-core"
import { Event, turnSource, type TurnSettled } from "../contracts/events"

export interface ChatMessage {
  readonly seq: number
  readonly kind: "assistant" | "agent" | "tool" | "error"
  readonly text: string
}
const ToolResult = Schema.Struct({ handle: Schema.Struct({ executor: Schema.String }), result: ResolutionResult })
const Answer = Schema.Struct({ answer: Schema.String })
const isEvent = Schema.is(Event)

// agentEvent returns the agent event a journal record carries, unwrapping inbound message bodies as durable atoms do; core records and replies return undefined.
export function agentEvent(record: { readonly event: unknown; readonly message?: { readonly inReplyTo?: unknown } }): Event | undefined {
  const event = isMessageReceived(record.event) && !record.message?.inReplyTo ? record.event.body : record.event
  return isEvent(event) ? event : undefined
}

// chatMessage projects an assistant reply or non-user inbox message at a journal position; output resolves a completed turn's text.
export function chatMessage(seq: number, event: Event, output: (settlement: TurnSettled) => string): ChatMessage | undefined {
  if (event.type === "TurnSettled") return { seq, kind: event.outcome === "completed" ? "assistant" : "error", text: event.outcome === "completed" ? output(event) : event.reason }
  if (event.type === "ActorRequestReceived") return { seq, kind: "agent", text: `Request ${event.request.requestId} (${event.request.method}): ${JSON.stringify(event.request.input)}` }
  if (event.type === "ActorReplyReceived") return { seq, kind: "agent", text: `Request ${event.requestId}: ${JSON.stringify(event.result)}` }
  if (event.type !== "TurnRequested" || turnSource(event) === "user") return undefined
  const kind = turnSource(event) === "agent" ? "agent" : "tool"
  const prefix = "Tool promise result (data): "
  if (!event.text.startsWith(prefix)) return { seq, kind, text: event.text }
  try {
    const value: unknown = JSON.parse(event.text.slice(prefix.length))
    if (!Schema.is(ToolResult)(value)) return { seq, kind, text: event.text }
    const result = value.result
    return {
      seq,
      kind: value.handle.executor === "actor" ? "agent" : "tool",
      text: result.status === "rejected" ? `Failed: ${result.reason}` : Schema.is(Answer)(result.value) ? result.value.answer : typeof result.value === "string" ? result.value : JSON.stringify(result.value),
    }
  } catch { return { seq, kind, text: event.text } }
}
