import { Schema } from "effect"
import { TurnError } from "./events"
import type { Event } from "@clavia/tardigrade-core/log/event"

// upcastError reads historical string failures and current structured failures (upcast.test.ts).
export const upcastError = (error: unknown): TurnError => Schema.is(TurnError)(error) ? error : { message: String(error ?? "") }

// responseKeyOf identifies one model response within its turn epoch (response.test.ts).
export const responseKeyOf = (event: Event, id: unknown): string =>
  JSON.stringify([event.turn ?? null, event.epoch ?? 0, id])

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
  const responses = new Set(events.filter((event) => event.type === "ModelReturned").map((event) => responseKeyOf(event, event.callId)))
  const head = events.find((event) => event.type === "MessageReceived")
  const initial = events.some((event) => event.type === "BudgetGranted" && event.initial === true)
  return {
    entries: events.map((event) => {
      const response = event.type === "ToolCalled" ? event.responseId ?? event.batchId : undefined
      const advancesInference = event.type === "ModelReturned"
        ? event.outcome === "returned"
        : event.type === "ToolCalled"
          ? event.responseId === undefined && (event.batchIndex === undefined || event.batchIndex === 0)
          : event.type === "OutputRejected" && !responses.has(responseKeyOf(event, event.attempt))
      return {
        event: (event.type === "TurnFailed" || (event.type === "ModelReturned" && event.error !== undefined)) ? { ...event, error: upcastError(event.error) } : event,
        ...(response === undefined ? {} : { responseKey: responseKeyOf(event, response) }),
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
