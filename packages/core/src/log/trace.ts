import { Tracer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"

// traceparentOf encodes a span as a W3C trace parent header.
export const traceparentOf = (span: { readonly traceId: string; readonly spanId: string }): string =>
  `00-${span.traceId}-${span.spanId}-01`

// linkOf reads an event's trace parent as an external span. Missing and malformed trace parents produce no link.
export const linkOf = (e: Event): Tracer.ExternalSpan | undefined => {
  const header = (e as { traceparent?: unknown }).traceparent
  if (typeof header !== "string") return undefined
  const parts = header.split("-")
  if (parts.length !== 4 || parts[1]!.length === 0 || parts[2]!.length === 0) return undefined
  return Tracer.externalSpan({ traceId: parts[1]!, spanId: parts[2]! })
}

// triggerOf returns the newest linkable span carried by an event log.
export const triggerOf = (events: ReadonlyArray<Event>): Tracer.ExternalSpan | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const link = linkOf(events[i]!)
    if (link !== undefined) return link
  }
  return undefined
}
