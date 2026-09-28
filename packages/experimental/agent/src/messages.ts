import { Schema } from "effect"
import { atom } from "@clavia/tardigrade-experimental-core"
import { ResolutionResult } from "@clavia/tardigrade-experimental-host"
import { history } from "./activity"
import { messageSource } from "./event"
import { turnOutput } from "./result"

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
    if (event.type !== "MessageReceived" || messageSource(event) === "user") return []
    if (event.kind === "request") return [{ seq, kind: "agent", text: event.request.description }]
    if (event.kind === "reply") return [{ seq, kind: "agent", text: `Request ${event.requestId}: ${event.decision.allowed ? "allowed" : "denied"}` }]
    const source = messageSource(event)
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
        text: result.status === "rejected" ? `Failed: ${result.error}` : Schema.is(Answer)(result.value) ? result.value.answer : typeof result.value === "string" ? result.value : JSON.stringify(result.value),
      }]
    } catch { return [{ seq, kind, text: event.text }] }
  })
})
