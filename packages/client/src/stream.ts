import type { Event } from "@clavia/tardigrade-core/log/event"

import { V1_PREFIX, type ActorThreadsEvent, type ActorThreadsEventRow, type EventRow } from "./contract"
import { NO_ANSWER, ProblemError } from "./problem"

// The log tail. Streaming responses are hand-written over EventSource because each connection
// carries a cursor and outlives an ordinary request. The transport is an argument rather than a
// global, so a consumer outside a browser supplies its own implementation (stream.test.ts).

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

interface FollowStreamOptions<Row> {
  readonly baseUrl: string
  readonly actor: string
  readonly after?: number | undefined
  readonly onEvent: (row: Row) => void
  readonly onError?: ((error: ProblemError) => void) | undefined
  readonly eventSource?: OpenEventSource | undefined
}

export interface StreamOptions extends FollowStreamOptions<EventRow> {
  readonly thread: string
}

export type ActorThreadsStreamOptions = FollowStreamOptions<ActorThreadsEventRow>

const trimSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

// streamUrl is the address one tail is opened at. It follows the declaration by hand because the
// tail is not a declared endpoint (contract.ts, the SSE note), so the prefix comes from the
// declaration's own constant rather than a second spelling of it. The thread id is encoded because
// a minted call id is not guaranteed to be path-safe
// (stream.test.ts, "the first connection carries after").
export const streamUrl = (
  baseUrl: string,
  actor: string,
  thread: string,
  after?: number
): string => {
  const suffix = after === undefined ? "" : `?after=${after}`
  return `${trimSlash(baseUrl)}${V1_PREFIX}/actors/${encodeURIComponent(actor)}/threads/${encodeURIComponent(thread)}/events/stream${suffix}`
}

export const actorThreadsStreamUrl = (baseUrl: string, actor: string, after?: number): string => {
  const suffix = after === undefined ? "" : `?after=${after}`
  return `${trimSlash(baseUrl)}${V1_PREFIX}/actors/${encodeURIComponent(actor)}/threads/stream${suffix}`
}

const follow = <Row>(options: {
  readonly url: string
  readonly subject: string
  readonly onEvent: (row: Row) => void
  readonly rowOf: (seq: number, data: string) => Row
  readonly onError?: ((error: ProblemError) => void) | undefined
  readonly eventSource?: OpenEventSource | undefined
}): (() => void) => {
  const open = options.eventSource ?? globalEventSource
  const source = open(options.url)
  source.onmessage = (frame) => {
    const seq = Number(frame.lastEventId)
    if (!Number.isFinite(seq)) return
    try {
      options.onEvent(options.rowOf(seq, frame.data))
    } catch {
      options.onError?.(new ProblemError({ title: "Unreadable Event", status: NO_ANSWER }))
    }
  }
  source.onerror = () => {
    if (source.readyState === CLOSED) {
      options.onError?.(
        new ProblemError({
          title: "Stream Closed",
          status: NO_ANSWER,
          detail: `The event stream for ${options.subject} ended and will not reconnect.`
        })
      )
    }
  }
  return () => source.close()
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
export const stream = (options: StreamOptions): (() => void) =>
  follow({
    ...options,
    url: streamUrl(options.baseUrl, options.actor, options.thread, options.after),
    subject: options.thread,
    rowOf: (seq, data) => ({ seq, event: JSON.parse(data) as Event })
  })

export const actorThreadsStream = (options: ActorThreadsStreamOptions): (() => void) =>
  follow({
    ...options,
    url: actorThreadsStreamUrl(options.baseUrl, options.actor, options.after),
    subject: options.actor,
    rowOf: (seq, data) => ({ seq, event: JSON.parse(data) as ActorThreadsEvent })
  })
