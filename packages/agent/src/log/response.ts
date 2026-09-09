import type { Event } from "@clavia/tardigrade-core/log/event"
import { upcast } from "./upcast"

// toolResponseKey identifies grouped tool requests (response.test.ts).
export const toolResponseKey = (event: Event): string | undefined => upcast([event]).entries[0]?.responseKey

// firstResponseCallIndex locates the first request in a response (response.test.ts).
export const firstResponseCallIndex = (events: ReadonlyArray<Event>, call: Event): number => {
  const entries = upcast(events).entries
  const index = events.indexOf(call)
  const key = entries[index]?.responseKey
  return key === undefined ? index : entries.findIndex((entry) => entry.responseKey === key)
}

// returnedAttemptCount counts responses that advance inference (response.test.ts).
export const returnedAttemptCount = (events: ReadonlyArray<Event>): number =>
  upcast(events).entries.filter((entry) => entry.advancesInference).length
