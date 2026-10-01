import { Schema } from "effect"
import { atom, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Event, ModelReply, Decision, turnSource } from "../contracts/events"

export const history = durableAtom({ name: "agent.activity.history", input: Event, schema: Schema.Array(Event), initial: [], reduce: (events, event) => [...events, event] })
export interface ActivityEntry {
  readonly seq: number
  readonly type: Event["type"]
  readonly summary: string
  readonly status: "info" | "message" | "notification" | "completed" | "failed"
}

function describe(event: Event): Pick<ActivityEntry, "summary" | "status"> {
  switch (event.type) {
    case "TurnRequested": {
      const source = turnSource(event)
      return { summary: `${source === "user" ? "" : `${source} · `}${event.text}`, status: source === "user" ? "message" : "notification" }
    }
    case "ActorRequestReceived": return { summary: `Request ${event.request.requestId}`, status: "notification" }
    case "ActorReplyReceived": return { summary: `Reply ${event.requestId}`, status: "notification" }
    case "ModelCalled": return { summary: `${event.purpose} · ${event.model.model_id}`, status: "info" }
    case "CompactionFailed": return { summary: event.reason, status: "failed" }
    case "ModelReturned": return { summary: event.text, status: "info" }
    case "PromiseSettled": {
      if (event.result.status === "rejected") return { summary: event.result.reason, status: "failed" }
      const value = event.result.value
      const summary = Schema.is(ModelReply)(value)
        ? value.toolCalls.length ? `tools · ${value.toolCalls.map(call => call.name).join(", ")}` : value.text
        : Schema.is(Decision)(value) ? `${value.allowed ? "allowed" : "denied"} · ${value.reason}`
        : typeof value === "string" ? value : "fulfilled"
      return { summary, status: "info" }
    }
    case "BudgetConfigured":
    case "BudgetUpdated": return { summary: `${event.policy.limit} ${event.metric} · turn`, status: "info" }
    case "PermissionConfigured":
    case "PermissionUpdated": return { summary: `default=${event.policy.default} · actions=${Object.keys(event.policy.actions).join(", ")}`, status: "info" }
    case "PermissionResolved": return { summary: `${event.action} · ${event.decision.allowed ? "allowed" : "denied"} · ${event.decision.reason}`, status: "notification" }
    case "ToolCalled": return { summary: event.callId, status: "info" }
    case "ToolReturned": return { summary: `${event.callId}${event.error ? ` · ${event.error}` : ""}`, status: event.error ? "failed" : "info" }
    case "TurnSettled": return { summary: `${event.outcome} · ${"reason" in event ? event.reason : "callId" in event ? event.callId : event.turnId}`, status: event.outcome === "completed" ? "completed" : "failed" }
    default: return { summary: "callId" in event ? event.callId : "", status: "info" }
  }
}

// activity projects agent events into presentation-neutral log entries.
export const activity = atom(get => get(history).map((event, seq): ActivityEntry => ({ seq, type: event.type, ...describe(event) })))
