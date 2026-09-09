import type { Event } from "@clavia/tardigrade-core/log/event"

export interface ReadEvent {
  readonly event: Event
  readonly responseKey?: string
  readonly advancesInference: boolean
}

export interface ReadHistory {
  readonly entries: ReadonlyArray<ReadEvent>
  readonly budget: {
    readonly startingAllowance: number | undefined
    readonly needsInitialGrant: boolean
  }
}

// upcast normalizes a history into read metadata without changing or synthesizing stored events (upcast.test.ts).
// Budget metadata describes a single turn. An undefined starting allowance requires the caller's fallback; an unrecorded historical default remains unknown.
export const upcast = (events: ReadonlyArray<Event>): ReadHistory => {
  const responseKey = (event: Event, id: unknown) => JSON.stringify([event.turn ?? null, event.epoch ?? 0, id])
  const responses = new Set(events.filter((event) => event.type === "ModelReturned").map((event) => responseKey(event, event.callId)))
  const head = events.find((event) => event.type === "MessageReceived")
  const initial = events.some((event) => event.type === "BudgetGranted" && event.initial === true)
  return {
    entries: events.map((event) => {
      const response = event.type === "ToolCalled" ? event.responseId ?? event.batchId : undefined
      const advancesInference = event.type === "ModelReturned"
        ? event.outcome === "returned"
        : event.type === "ToolCalled"
          ? event.responseId === undefined && (event.batchIndex === undefined || event.batchIndex === 0)
          : event.type === "OutputRejected" && !responses.has(responseKey(event, event.attempt))
      return {
        event,
        ...(response === undefined ? {} : { responseKey: responseKey(event, response) }),
        advancesInference
      }
    }),
    budget: {
      startingAllowance: initial ? 0 : typeof head?.budget === "number" && head.budget > 0 ? Math.floor(head.budget) : undefined,
      needsInitialGrant: head !== undefined && !events.some((event) =>
        event.type === "BudgetGranted" || event.type === "ModelCalled" || event.type === "ToolCalled" ||
        event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled")
    }
  }
}
