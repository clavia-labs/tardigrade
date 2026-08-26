import type { Event } from "@clavia/tardigrade-core/log/event"

import { V1_PREFIX, type EventRow } from "./contract"
import { NO_ANSWER, ProblemError } from "./problem"

// The log tail. The stream is not a declared endpoint, because HttpApi is request-and-response
// shaped and this is a connection with a cursor (apps/server/src/api.ts, layerStream), so it is
// hand-written here over EventSource. The transport is an argument rather than a global, so a
// consumer outside a browser supplies its own implementation (stream.test.ts).

// The EventSource readyState that means the connection is gone for good.
export const CLOSED = 2

// One SSE frame, in the two fields this tail reads. The server puts the event's seq in the frame's
// `id`, which is also what a reconnecting source sends back as Last-Event-ID, so the seq and the
// resume point are the same number.
export interface Frame {
  readonly data: string
  readonly lastEventId: string
}

// The part of EventSource this helper uses. It is the DOM interface narrowed to what a tail needs,
// so `globalThis.EventSource` satisfies it and so does a stand-in.
export interface EventSourceLike {
  onmessage: ((frame: Frame) => void) | null
  onerror: ((event: unknown) => void) | null
  readonly readyState: number
  close(): void
}

// How a connection is opened. The default is `globalThis.EventSource`, read at call time rather
// than at import, so this module loads in a runtime that has none.
export type OpenEventSource = (url: string) => EventSourceLike

const globalEventSource: OpenEventSource = (url) => {
  const ctor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource
  if (ctor === undefined) {
    throw new ProblemError({
      title: "No EventSource",
      status: NO_ANSWER,
      detail: "This runtime has no EventSource. Pass one as `eventSource` to follow a log."
    })
  }
  return new ctor(url)
}

export interface StreamOptions {
  readonly baseUrl: string
  readonly thread: string
  // Where the first connection starts. A reconnect ignores it: the source replays the same URL with
  // a Last-Event-ID header, and the server prefers that header, so a resume lands where the dropped
  // connection stopped rather than back at `after` (apps/server/src/api.ts, layerStream).
  readonly after?: number | undefined
  readonly onEvent: (row: EventRow) => void
  readonly onError?: ((error: ProblemError) => void) | undefined
  readonly eventSource?: OpenEventSource | undefined
}

const trimSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

// streamUrl is the address one tail is opened at. It follows the declaration by hand because the
// tail is not a declared endpoint (contract.ts, the SSE note), so the prefix comes from the
// declaration's own constant rather than a second spelling of it. The thread id is encoded because
// a minted call id is not guaranteed to be path-safe
// (stream.test.ts, "the first connection carries after").
export const streamUrl = (
  baseUrl: string,
  thread: string,
  after?: number
): string => {
  const suffix = after === undefined ? "" : `?after=${after}`
  return `${trimSlash(baseUrl)}${V1_PREFIX}/threads/${encodeURIComponent(thread)}/events/stream${suffix}`
}

// stream follows one thread's log and returns the unsubscribe. Reconnection belongs to the
// EventSource, and so does the Last-Event-ID it carries; this function adds only the frame decoding
// and the seq, so a source that drops and resumes keeps feeding the same handler and no event is
// numbered twice (stream.test.ts, "a resumed connection keeps feeding the same handler").
//
// A bearer token cannot ride this call: EventSource sends no headers, and the server reads the
// token from `authorization` alone (apps/server/src/http.ts, bearerOf). Against a server started
// with TARDIGRADE_TOKEN the tail is refused and `onError` reports it, which is why a caller keeps
// an ordinary `events` poll as the fallback.
export const stream = (options: StreamOptions): (() => void) => {
  const open = options.eventSource ?? globalEventSource
  const source = open(streamUrl(options.baseUrl, options.thread, options.after))
  source.onmessage = (frame) => {
    const seq = Number(frame.lastEventId)
    if (!Number.isFinite(seq)) return
    try {
      options.onEvent({ seq, event: JSON.parse(frame.data) as Event })
    } catch {
      options.onError?.(new ProblemError({ title: "Unreadable Event", status: NO_ANSWER }))
    }
  }
  source.onerror = () => {
    // A source reconnects on its own unless it has given up, so only a closed one is a failure the
    // caller has to show.
    if (source.readyState === CLOSED) {
      options.onError?.(
        new ProblemError({
          title: "Stream Closed",
          status: NO_ANSWER,
          detail: `The event stream for ${options.thread} ended and will not reconnect.`
        })
      )
    }
  }
  return () => source.close()
}
