// The client. Every screen reads the server through this module and nothing else, so the wire
// shapes are stated once and the app holds no second idea of what an agent is (voyager-spec.md,
// "Stack").
//
// The types are copies of the server's projections (apps/server/src/projections.ts, api.ts). They
// are copied rather than imported because the browser bundle would otherwise pull the server's
// effect graph in behind them; a shared package replaces the copy when one earns its keep.

// Event is the log's own entry, kept structural here. The narrative reads `type` and whichever
// fields the type carries, and the server ships the event verbatim, so narrowing belongs to the
// screen that renders a given type rather than to the transport.
export interface Event {
  readonly type: string
  readonly [field: string]: unknown
}

// AgentStatus is the summary vocabulary of GET /agents (projections.ts, statusOf). The four words
// are the server's own; the app renders them and holds no second vocabulary.
export type AgentStatus = "settled" | "running" | "blocked" | "failed"

// AgentSummary is one row of GET /agents. `parent` is absent for a root, `lastAt` for an agent
// whose events carry no timestamp.
export interface AgentSummary {
  readonly id: string
  readonly parent?: string
  readonly events: number
  readonly lastAt?: number
  readonly status: AgentStatus
}

// AgentNode is a summary with the agents it spawned, the shape GET /agents/:id/tree serves.
export interface AgentNode extends AgentSummary {
  readonly children: ReadonlyArray<AgentNode>
}

// TurnStatus is the turn vocabulary of GET /agents/:id/turns. `parked` is a turn waiting on a
// budget answer the API has no door for; it is alive, never failed.
export type TurnStatus = "pending" | "completed" | "failed" | "parked"

export interface TurnView {
  readonly turn: string
  readonly status: TurnStatus
  readonly output?: string
  readonly error?: string
}

// EventRow is one row of GET /agents/:id/events. `seq` is the event's 1-based position in the whole
// log, assigned before any filter runs, so `after` means the same place under a `types` filter.
export interface EventRow {
  readonly seq: number
  readonly event: Event
}

// Health is GET /healthz: the driver's state and the count of drive passes owed.
export interface Health {
  readonly status: "resting" | "driving"
  readonly dirty: number
}

export interface Accepted {
  readonly agent: string
  readonly turn: string
}

// Where the server listens when VITE_API_URL is absent, matching the server's own DEFAULT_PORT
// (apps/server/src/config.ts).
export const DEFAULT_API_URL = "http://localhost:4111"

// The localStorage key the bearer token is pasted into. The token is the server's whole auth story
// (apps/server/src/http.ts, layerAuth), so the app stores one string and sends it on every fetch.
export const TOKEN_KEY = "voyager.token"

const trimSlash = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

// The server address. A query param wins over the build's env so one build can point at another
// process without a rebuild (voyager-spec.md, "Conventions").
export const apiUrl = (): string => {
  const fromEnv = import.meta.env?.VITE_API_URL
  const configured = typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : DEFAULT_API_URL
  if (typeof location === "undefined") return trimSlash(configured)
  const stated = new URLSearchParams(location.search).get("api")
  return trimSlash(stated !== null && stated.length > 0 ? stated : configured)
}

export const token = (): string | undefined => {
  if (typeof localStorage === "undefined") return undefined
  const stored = localStorage.getItem(TOKEN_KEY)
  return stored === null || stored.length === 0 ? undefined : stored
}

// Query is the search params a call may state. An undefined value is not sent, so a caller passes
// its options straight through without assembling a string.
export type Query = Readonly<Record<string, string | number | undefined>>

// url builds one endpoint's address. Path segments are encoded because an agent id is a minted call
// id and a turn id is a client-supplied message id; neither is guaranteed to be path-safe.
export const url = (path: string, query: Query = {}, base = apiUrl()): string => {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.set(name, String(value))
  }
  const suffix = search.size === 0 ? "" : `?${search.toString()}`
  return `${trimSlash(base)}${path}${suffix}`
}

export const agentPath = (id: string): string => `/agents/${encodeURIComponent(id)}`

// VoyagerError is what a failed call throws. `title` and `detail` are the problem document's own
// words and the UI renders them verbatim; a response that is not a problem document still lands
// here, with the status line standing in for the title, so a screen handles one error shape
// (apps/server/src/problem.ts).
export class VoyagerError extends Error {
  readonly title: string
  readonly detail: string | undefined
  readonly status: number

  constructor(options: { title: string; detail?: string | undefined; status: number }) {
    super(options.detail === undefined ? options.title : `${options.title}: ${options.detail}`)
    this.name = "VoyagerError"
    this.title = options.title
    this.detail = options.detail
    this.status = options.status
  }
}

// problemOf reads a failed response's body as RFC 9457. A body that is not one, or is not JSON at
// all, yields the status text: the app invents no error prose either way.
export const problemOf = (status: number, statusText: string, body: unknown): VoyagerError => {
  const fallback = statusText.length > 0 ? statusText : `Request failed with status ${status}`
  if (typeof body !== "object" || body === null) {
    return new VoyagerError({ title: fallback, status })
  }
  const { detail, title } = body as { title?: unknown; detail?: unknown }
  return new VoyagerError({
    title: typeof title === "string" && title.length > 0 ? title : fallback,
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
    status
  })
}

const authorized = (headers: Record<string, string> = {}): Record<string, string> => {
  const bearer = token()
  return bearer === undefined ? headers : { ...headers, authorization: `Bearer ${bearer}` }
}

const request = async <A>(path: string, query: Query, init?: RequestInit): Promise<A> => {
  const headers = authorized(init?.body === undefined ? {} : { "content-type": "application/json" })
  const response = await fetch(url(path, query), { ...init, headers })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw problemOf(response.status, response.statusText, body)
  return body as A
}

export const listAgents = (): Promise<ReadonlyArray<AgentSummary>> => request("/agents", {})

export const tree = (id: string): Promise<AgentNode> => request(`${agentPath(id)}/tree`, {})

export interface EventsOptions {
  // The seq to read past. The server numbers events from 1, so `after: 40` starts at 41.
  readonly after?: number
  readonly limit?: number
  // Event type names, sent as one comma-joined `types` param.
  readonly types?: ReadonlyArray<string>
}

export const events = (id: string, opts: EventsOptions = {}): Promise<ReadonlyArray<EventRow>> =>
  request(`${agentPath(id)}/events`, {
    after: opts.after,
    limit: opts.limit,
    types: opts.types === undefined || opts.types.length === 0 ? undefined : opts.types.join(",")
  })

// `at` cuts the log to a prefix before the projection runs, which is the whole of time travel: any
// prefix of a log is a valid state (projections.ts, turnsOf).
export const turns = (id: string, at?: number): Promise<ReadonlyArray<TurnView>> =>
  request(`${agentPath(id)}/turns`, { at })

export const turn = (id: string, turnId: string): Promise<TurnView> =>
  request(`${agentPath(id)}/turns/${encodeURIComponent(turnId)}`, {})

// send delivers one message. `messageId` is the dedup key end to end and becomes the turn id, so a
// double-click on the composer costs nothing (apps/server/src/host.ts, Inbound).
export const send = (id: string, message: string, messageId = crypto.randomUUID()): Promise<Accepted> =>
  request(`${agentPath(id)}/messages`, {}, {
    method: "POST",
    body: JSON.stringify({ id: messageId, text: message })
  })

export const resume = (id: string, turnId: string): Promise<Accepted> =>
  request(`${agentPath(id)}/turns/${encodeURIComponent(turnId)}/resume`, {}, { method: "POST" })

export const health = (): Promise<Health> => request("/healthz", {})

export interface StreamOptions {
  // Where the first connection starts. A reconnect ignores it: the browser replays the same URL
  // with a Last-Event-ID header, and the server prefers that header, so a resume lands where the
  // dropped connection stopped rather than back at `after` (apps/server/src/api.ts, layerStream).
  readonly after?: number
  readonly onEvent: (row: EventRow) => void
  readonly onError?: (error: VoyagerError) => void
}

// The EventSource readyState that means the connection is gone for good.
const CLOSED = 2

// stream follows one agent's log and returns the unsubscribe. Reconnection is the browser's, and
// so is the Last-Event-ID it carries; this function adds only the frame decoding and the seq, which
// the server puts in the frame's `id` field.
//
// The bearer token cannot ride this call: EventSource sends no headers, and the server reads the
// token from `authorization` alone (apps/server/src/http.ts, bearerOf). Against a server started
// with TARDIGRADE_TOKEN the stream is refused and `onError` reports it; the screens fall back to
// polling `events`, which is an ordinary fetch and carries the header.
export const stream = (id: string, options: StreamOptions): (() => void) => {
  const source = new EventSource(url(`${agentPath(id)}/events/stream`, { after: options.after }))
  source.onmessage = (frame: MessageEvent<string>) => {
    const seq = Number(frame.lastEventId)
    if (!Number.isFinite(seq)) return
    try {
      options.onEvent({ seq, event: JSON.parse(frame.data) as Event })
    } catch {
      options.onError?.(new VoyagerError({ title: "Unreadable Event", status: 0 }))
    }
  }
  source.onerror = () => {
    // The browser reconnects on its own unless it has given up, so only a closed source is a
    // failure the screen has to show.
    if (source.readyState === CLOSED) {
      options.onError?.(
        new VoyagerError({
          title: "Stream Closed",
          detail: `The event stream for ${id} ended and will not reconnect.`,
          status: 0
        })
      )
    }
  }
  return () => source.close()
}
