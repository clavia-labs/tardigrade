import { invocationKey } from "@clavia/tardigrade-core/interaction/invocation"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { upcast } from "./upcast"

// responsesOf indexes response groups and counts completed attempts without changing event identity (response.test.ts).
export const responsesOf = (events: ReadonlyArray<Event>): {
  readonly keys: ReadonlyMap<Event, string>
  readonly firstCalls: ReadonlyMap<Event, Event>
  readonly text: ReadonlyMap<Event, string>
  readonly returnedAttempts: number
} => {
  const keys = new Map<Event, string>()
  const firstCalls = new Map<Event, Event>()
  const groups = new Map<string, Event>()
  const text = new Map<Event, string>()
  const prose = new Map<string, Event>()
  const partials = new Map<string, Event>()
  const cancelled = new Map<string, Event>()
  let returnedAttempts = 0
  for (const { event, invocation, responseKey, advancesInference } of upcast(events).entries) {
    const owner = invocation === undefined ? undefined : invocationKey(invocation)
    if (event.type === "TextReturned") {
      if (responseKey !== undefined) prose.set(responseKey, event)
      if (owner !== undefined) partials.set(owner, event)
    } else if (event.type === "TurnCancelled" && owner !== undefined) {
      cancelled.set(owner, event)
    } else if ((event.type === "ModelCalled" || event.type === "TurnCompleted" || event.type === "TurnFailed") && owner !== undefined) {
      partials.delete(owner)
    }
    if (advancesInference) returnedAttempts += 1
    if (event.type !== "ToolCalled") continue
    const preamble = responseKey === undefined ? undefined : prose.get(responseKey)
    if (preamble !== undefined && (owner === undefined || !cancelled.has(owner))) {
      text.set(event, String(preamble.text ?? ""))
      prose.delete(responseKey!)
      if (owner !== undefined && partials.get(owner) === preamble) partials.delete(owner)
    }
    if (event.responseId === undefined && event.batchId === undefined) {
      firstCalls.set(event, event)
    } else {
      const first = groups.get(responseKey!) ?? event
      groups.set(responseKey!, first)
      keys.set(event, responseKey!)
      firstCalls.set(event, first)
    }
  }
  for (const [owner, terminal] of cancelled) {
    const partial = partials.get(owner)
    if (partial !== undefined) text.set(terminal, String(partial.text ?? ""))
  }
  return { keys, firstCalls, text, returnedAttempts }
}

// hasUnansweredToolCall reports whether an event slice still awaits a tool result.
export const hasUnansweredToolCall = (events: ReadonlyArray<Event>): boolean => {
  const answered = new Set(
    events.filter((event) => event.type === "ToolReturned").map((event) => String(event.callId))
  )
  return events.some((event) => event.type === "ToolCalled" && !answered.has(String(event.callId)))
}
