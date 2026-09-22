import { upcastResponse } from "./response-upcast"
import { Schema } from "effect"
import { TurnError } from "./events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { AiError } from "effect/unstable/ai"
import { modelErrorOf } from "../model/error"

// upcastError reads historical string failures and current structured failures (upcast.test.ts).
export const upcastError = (error: unknown): TurnError => {
  const native = AiError.isAiError(error) ? error : modelErrorOf(error)
  if (native !== undefined) return {
    message: native.message,
    code: native.reason._tag,
    isRetryable: native.isRetryable,
    ...("http" in native.reason && native.reason.http?.response !== undefined ? { statusCode: native.reason.http.response.status } : {})
  }
  return Schema.is(TurnError)(error) ? error : { message: String(error ?? "") }
}

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
}

// upcast normalizes a history into read metadata without changing or synthesizing stored events (upcast.test.ts).
export const upcast = (events: ReadonlyArray<Event>): ReadHistory => {
  const responses = new Set(events.filter((event) => event.type === "ModelReturned").map((event) => responseKeyOf(event, event.callId)))
  return {
    entries: events.map((stored) => {
      const event = upcastResponse(stored)
      const response = event.type === "ToolCalled" ? event.responseId ?? event.batchId : undefined
      const advancesInference = event.type === "ModelReturned"
        ? event.outcome === "returned"
        : event.type === "ToolCalled"
          ? event.responseId === undefined && (event.batchIndex === undefined || event.batchIndex === 0)
          : event.type === "OutputRejected" && !responses.has(responseKeyOf(event, event.attempt))
      return {
        event: event.type === "TurnFailed" ? { ...event, error: upcastError(event.error) } : event,
        ...(response === undefined ? {} : { responseKey: responseKeyOf(event, response) }),
        advancesInference
      }
    })
  }
}
