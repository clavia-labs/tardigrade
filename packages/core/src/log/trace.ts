import { Tracer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"

// The trace seam of the event grammar: a delivered event MAY carry `traceparent`, the W3C
// header form of the span that sent it. The platform stamps it at delivery and packages read it,
// so the reconciler can link a fire to the delivery that enabled its work.

export const traceparentOf = (span: { readonly traceId: string; readonly spanId: string }): string =>
  `00-${span.traceId}-${span.spanId}-01`

// linkOf reads an event's carried context back into a linkable span. An event without one, or
// with an unreadable one, links nothing.
export const linkOf = (e: Event): Tracer.ExternalSpan | undefined => {
  const header = (e as { traceparent?: unknown }).traceparent
  if (typeof header !== "string") return undefined
  const parts = header.split("-")
  if (parts.length !== 4 || parts[1]!.length === 0 || parts[2]!.length === 0) return undefined
  return Tracer.externalSpan({ traceId: parts[1]!, spanId: parts[2]! })
}

// triggerOf returns the newest carried context on the log.
export const triggerOf = (events: ReadonlyArray<Event>): Tracer.ExternalSpan | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const link = linkOf(events[i]!)
    if (link !== undefined) return link
  }
  return undefined
}
