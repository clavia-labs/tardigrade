import { Schema } from "effect"
import { atom, ResolutionResult } from "@clavia/tardigrade-experimental-core"
import { history } from "./activity"
import { turnSource } from "../contracts/events"
import { turnOutput } from "./durable/inference"

export interface ChatMessage {
  readonly seq: number
  readonly kind: "assistant" | "agent" | "tool" | "error"
  readonly text: string
}
const ToolResult = Schema.Struct({ handle: Schema.Struct({ executor: Schema.String }), result: ResolutionResult })
const Answer = Schema.Struct({ answer: Schema.String })

// messages projects assistant replies and non-user inbox messages for chat interfaces.
export const messages = atom(get => {
  const events = get(history)
  return events.flatMap((event, seq): ChatMessage[] => {
    if (event.type === "TurnSettled") return [{ seq, kind: event.outcome === "completed" ? "assistant" : "error", text: event.outcome === "completed" ? turnOutput(events, event) : event.reason }]
    if (event.type === "ActorRequestReceived") return [{ seq, kind: "agent", text: `Request ${event.request.requestId} (${event.request.method}): ${JSON.stringify(event.request.input)}` }]
    if (event.type === "ActorReplyReceived") return [{ seq, kind: "agent", text: `Request ${event.requestId}: ${JSON.stringify(event.result)}` }]
    if (event.type !== "TurnRequested" || turnSource(event) === "user") return []
    const source = turnSource(event)
    const kind = source === "agent" ? "agent" : "tool"
    const prefix = "Tool promise result (data): "
    if (!event.text.startsWith(prefix)) return [{ seq, kind, text: event.text }]
    try {
      const value: unknown = JSON.parse(event.text.slice(prefix.length))
      if (!Schema.is(ToolResult)(value)) return [{ seq, kind, text: event.text }]
      const result = value.result
      return [{
        seq,
        kind: value.handle.executor === "actor" ? "agent" : "tool",
        text: result.status === "rejected" ? `Failed: ${result.reason}` : Schema.is(Answer)(result.value) ? result.value.answer : typeof result.value === "string" ? result.value : JSON.stringify(result.value),
      }]
    } catch { return [{ seq, kind, text: event.text }] }
  })
})
