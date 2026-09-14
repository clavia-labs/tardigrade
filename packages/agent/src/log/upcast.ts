import { actorInvocationContextFrom, InvocationRef, invocationKey } from "@clavia/tardigrade-core/interaction/invocation"
import { upcastResponse } from "./response-upcast"
import { Schema } from "effect"
import { TurnError } from "./events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { AiError } from "effect/unstable/ai"
import { modelErrorOf } from "../inference/error"

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

// invocationOf resolves runtime ownership before legacy turn stamps (response.test.ts).
const invocationOf = (event: Event, legacyEpoch = 0): InvocationRef | undefined =>
  event.invocationRef !== undefined ? Schema.decodeUnknownSync(InvocationRef)(event.invocationRef)
    : actorInvocationContextFrom(event)?.invocation ?? (typeof event.turn === "string"
      ? { method: "message", id: event.turn, epoch: Number(event.epoch ?? legacyEpoch) }
      : undefined)

const responseKey = (invocation: InvocationRef | undefined, id: unknown): string =>
  JSON.stringify([invocation?.method ?? "message", invocation?.id ?? null, invocation?.epoch ?? 0, id])

// responseKeyOf identifies one model response within its owning invocation (response.test.ts).
export const responseKeyOf = (event: Event, id: unknown): string => responseKey(invocationOf(event), id)

export interface ReadEvent {
  readonly event: Event
  readonly invocation?: InvocationRef
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
  // Legacy text lacks response IDs or epochs; only this reader infers them from preceding marks (inference/request.test.ts).
  const epochs = new Map<string, number>()
  const activeResponses = new Map<string, unknown>()
  return {
    entries: events.map((stored, index) => {
      const event = upcastResponse(stored)
      const inherited = event.type === "TextReturned" && typeof event.turn === "string" ? epochs.get(event.turn) : undefined
      const invocation = invocationOf(event, inherited)
      if (invocation !== undefined && (event.invocationRef !== undefined || event.epoch !== undefined || actorInvocationContextFrom(event) !== undefined)) epochs.set(invocation.id, invocation.epoch)
      const owner = invocation === undefined ? "legacy-unscoped" : invocationKey(invocation)
      let response = event.responseId ?? event.batchId
      if (event.type === "ModelCalled" || event.type === "ModelReturned") {
        response = event.callId
        activeResponses.set(owner, response)
      } else if (event.type === "TextReturned") {
        response ??= activeResponses.get(owner) ?? ["legacy-text", index]
        activeResponses.set(owner, response)
      } else if (event.type === "ToolCalled") {
        response ??= activeResponses.get(owner)
      } else if (event.type === "MessageReceived") {
        activeResponses.delete("legacy-unscoped")
      }
      const advancesInference = event.type === "ModelReturned"
        ? event.outcome === "returned"
        : event.type === "ToolCalled"
          ? event.responseId === undefined && (event.batchIndex === undefined || event.batchIndex === 0)
          : event.type === "OutputRejected" && !responses.has(responseKeyOf(event, event.attempt))
      return {
        event: event.type === "TurnFailed" ? { ...event, error: upcastError(event.error) } : event,
        ...(invocation === undefined ? {} : { invocation }),
        ...(response === undefined ? {} : { responseKey: responseKey(invocation, response) }),
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
