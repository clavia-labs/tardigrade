import type { Event } from "@clavia/tardigrade-core/log/event"
import { upcast } from "./upcast"

// responsesOf indexes response groups and counts completed attempts without changing event identity (response.test.ts).
export const responsesOf = (events: ReadonlyArray<Event>): {
  readonly keys: ReadonlyMap<Event, string>
  readonly firstCalls: ReadonlyMap<Event, Event>
  readonly returnedAttempts: number
} => {
  const keys = new Map<Event, string>()
  const firstCalls = new Map<Event, Event>()
  const groups = new Map<string, Event>()
  let returnedAttempts = 0
  for (const { event, responseKey, advancesInference } of upcast(events).entries) {
    if (advancesInference) returnedAttempts += 1
    if (event.type !== "ToolCalled") continue
    if (responseKey === undefined) {
      firstCalls.set(event, event)
    } else {
      const first = groups.get(responseKey) ?? event
      groups.set(responseKey, first)
      keys.set(event, responseKey)
      firstCalls.set(event, first)
    }
  }
  return { keys, firstCalls, returnedAttempts }
}
