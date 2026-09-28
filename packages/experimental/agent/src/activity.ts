import { Schema } from "effect"
import { atom, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Event, ModelReply, messageSource } from "./event"

export const history = durableAtom({ input: Event, schema: Schema.Array(Event), initial: [], reduce: (events, event) => [...events, event] })
export interface ActivityEntry {
  readonly seq: number
  readonly type: Event["type"]
  readonly summary: string
  readonly status: "info" | "message" | "notification" | "completed" | "failed"
}

function describe(event: Event): Pick<ActivityEntry, "summary" | "status"> {
  switch (event.type) {
    case "MessageReceived": {
      const source = messageSource(event)
      return { summary: `${source === "user" ? "" : `${source} · `}${event.kind === "message" ? event.text : event.kind}`, status: source === "user" ? "message" : "notification" }
    }
    case "ModelCalled": return { summary: `${event.purpose} · ${event.model.model_id}`, status: "info" }
    case "ModelReturned": return { summary: "promise" in event ? `submitted · ${event.callId}` : event.text, status: "info" }
    case "PromiseSettled": {
      if (event.result.status === "rejected") return { summary: event.result.error, status: "failed" }
      const value = event.result.value
      const summary = Schema.is(ModelReply)(value)
        ? value.toolCalls.length ? `tools · ${value.toolCalls.map(call => call.name).join(", ")}` : value.text
        : typeof value === "string" ? value : "fulfilled"
      return { summary, status: "info" }
    }
    case "ToolCalled": return { summary: event.callId, status: "info" }
    case "ToolReturned": return { summary: `${event.callId}${event.error ? ` · ${event.error}` : ""}`, status: event.error ? "failed" : "info" }
    case "TurnSettled": return { summary: `${event.outcome} · ${"reason" in event ? event.reason : "callId" in event ? event.callId : event.turnId}`, status: event.outcome === "completed" ? "completed" : "failed" }
    default: return { summary: "callId" in event ? event.callId : "", status: "info" }
  }
}

// activity projects agent events into presentation-neutral log entries.
export const activity = atom(get => get(history).map((event, seq): ActivityEntry => ({ seq, type: event.type, ...describe(event) })))
