import { Tracer } from "effect"
import type { Event } from "./event"

// The trace seam of the event grammar: a delivered event MAY carry `traceparent`, the W3C
// header form of the span that sent it (00-<traceId>-<spanId>-01). The PLATFORM stamps it at
// delivery, where the sending span is current; the packages only read it, so the reconciler can
// link a fire to the delivery that woke the work and one business event stays one trace across
// every lane it touches. Links, never parents: one settle serves many deliveries, and the
// messaging conventions make links the default for exactly that reason (platform/bun's
// host.test.ts, "one trace across lanes").

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

// triggerOf is the settle's approximation of "what woke this work": the newest carried context
// on the log. A settle that serves several fresh deliveries links them all to the same trigger;
// finer attribution needs the derivation to name its inputs, which a projection cannot.
export const triggerOf = (events: ReadonlyArray<Event>): Tracer.ExternalSpan | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const link = linkOf(events[i]!)
    if (link !== undefined) return link
  }
  return undefined
}
