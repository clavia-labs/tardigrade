import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { ModelUsage } from "../inference/response"
import { modelErrorOf } from "../inference/error"

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

// upcastUsage converts historical flat counts without inventing missing values (inference/response.test.ts).
export const upcastUsage = (value: unknown): ModelUsage => {
  if (Schema.is(ModelUsage)(value)) return value
  const old = record(value)
  const count = (name: string) => typeof old[name] === "number" && Number.isFinite(old[name]) ? old[name] as number : undefined
  return {
    inputTokens: {
      ...(count("promptTokens") === undefined ? {} : { total: count("promptTokens") }),
      ...(count("cachedPromptTokens") === undefined ? {} : { cacheRead: count("cachedPromptTokens") }),
      ...(count("cacheWritePromptTokens") === undefined ? {} : { cacheWrite: count("cacheWritePromptTokens") })
    },
    outputTokens: {
      ...(count("completionTokens") === undefined ? {} : { total: count("completionTokens") }),
      ...(count("reasoningTokens") === undefined ? {} : { reasoning: count("reasoningTokens") })
    }
  }
}

// upcastResponse retains historical accounting and errors beside the current response view (inference/response.test.ts).
export const upcastResponse = (event: Event): Event => {
  if (event.type !== "ModelReturned") return event
  if (event.error !== undefined && modelErrorOf(event.error) === undefined) {
    const { error, ...rest } = event
    event = { ...rest, legacyError: event.legacyError ?? error } as Event
  }
  if (event.usage === undefined || Schema.is(ModelUsage)(event.usage)) return event
  return {
    ...event,
    usage: upcastUsage(event.usage),
    legacyUsage: event.legacyUsage ?? event.usage
  }
}
