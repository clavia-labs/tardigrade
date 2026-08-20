import type { Event } from "@clavia/tardigrade-core/event"
import { REPLY_SUFFIX } from "@clavia/tardigrade-core/message"
import { canProgress, factsOf } from "@clavia/tardigrade-code/projections"
import { boundaryOf } from "@clavia/tardigrade/boundary"

// The read side of the API. Every endpoint that answers a question about a thread answers it here,
// as a pure function of that thread's events (apps-server-spec.md, "Principles": every read is a
// projection of the log). Nothing in this module touches a store, a host, or a clock, so a route is
// a lookup plus one of these calls, and a test is an array of events.
//
// The projections read the framework's own projections wherever one already answers the question:
// the lane's owed work comes from the code lane (@clavia/tardigrade-code/projections), and a turn's
// outcome comes from the thread's boundary (@clavia/tardigrade/boundary). The vocabulary the wire
// speaks is the only thing added here.

// ThreadStatus is the summary vocabulary of GET /v1/actors/:actor/threads. Four answers, in the order they are
// decided: a thread whose work cannot move is blocked, a thread that owes a transition is running,
// a thread whose last turn died owing nothing is failed, and anything else has settled.
export type ThreadStatus = "settled" | "running" | "blocked" | "failed"

const numberAt = (event: Event): number | undefined => {
  const at = (event as { at?: unknown }).at
  return typeof at === "number" ? at : undefined
}

const idOf = (event: Event): string => String((event as { id?: unknown }).id ?? "")

// inboundOf returns the ids of the turns a log was asked to serve, in log order. A reply is an
// inbound event and never an inbound turn: it answers an id this thread sent out, under that id's
// own `<id>.reply` name (@clavia/tardigrade-core/message, REPLY_SUFFIX), so listing it would report
// a child's answer as a turn of the parent (projections.test.ts, "a reply message is not a turn").
const inboundOf = (events: ReadonlyArray<Event>): ReadonlyArray<string> => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== "MessageReceived") continue
    const id = idOf(event)
    if (id === "" || id.endsWith(REPLY_SUFFIX) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

// statusOf reports what the thread is doing, decided in one order because the states overlap in the
// log: a blocked lane also has a turn without a terminal, and a failed turn is only failed once
// nothing is owed (apps-server-spec.md, "GET /v1/actors/:actor/threads").
//
// The first two answers are the code lane's own head-of-queue reading, not a second derivation of
// it: `workOwed` is this head plus `canProgress`, so blocked is exactly the case that leaves
// `workOwed` empty while an execution is still open (@clavia/tardigrade-code/projections). Blocked
// means an open `BlockedOn` whose awaited reply has not landed; the moment it lands the same head
// can progress and reads running again (projections.test.ts, "a landed reply unblocks the lane").
//
// A turn with no terminal and no owed execution is running as well: the model owes the next
// transition, and no code has been dispatched yet (projections.test.ts, "a fresh turn is running").
export const statusOf = (events: ReadonlyArray<Event>): ThreadStatus => {
  const head = factsOf(events).find((facts) => !facts.settled)
  if (head !== undefined) return canProgress(head) ? "running" : "blocked"
  const turns = inboundOf(events)
  const last = turns[turns.length - 1]
  if (last === undefined) return "settled"
  const boundary = boundaryOf(events, last)
  if (boundary === undefined) return "running"
  return boundary.kind === "failed" ? "failed" : "settled"
}

// ThreadSummary is one row of GET /v1/actors/:actor/threads: what a thread is, without its events. `parent` is absent
// for a root, and `lastAt` for a thread whose events carry no timestamp.
export interface ThreadSummary {
  readonly id: string
  readonly parent?: string
  readonly events: number
  readonly lastAt?: number
  readonly status: ThreadStatus
}

// summaryOf projects one log into its row. `parent` is a parameter because a child's own log holds
// no evidence of its parent: the claim is a `PackageCalled` in the PARENT's log, so parentage is a
// fact of the forest and only `treeOf` can see it (projections.test.ts, "a summary carries the
// parent the caller supplies").
export const summaryOf = (id: string, events: ReadonlyArray<Event>, parent?: string): ThreadSummary => {
  let lastAt: number | undefined
  for (const event of events) {
    const at = numberAt(event)
    if (at !== undefined) lastAt = at
  }
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    events: events.length,
    ...(lastAt === undefined ? {} : { lastAt }),
    status: statusOf(events)
  }
}

// ThreadNode is a summary with the threads it spawned, the shape GET /v1/actors/:actor/threads/:id/tree serves.
export interface ThreadNode extends ThreadSummary {
  readonly children: ReadonlyArray<ThreadNode>
}

// firstAt is the log's own start, the order the forest is listed in. A log with no timestamp sorts
// last rather than first, so an untimed thread never displaces a real one.
const firstAt = (events: ReadonlyArray<Event>): number => {
  for (const event of events) {
    const at = numberAt(event)
    if (at !== undefined) return at
  }
  return Number.POSITIVE_INFINITY
}

// treeOf builds the spawn forest. X is the parent of Y when X's log records a `PackageCalled` whose
// `callId` is Y's id: a spawn names its child by the call's own id and places it at `ag.<callId>`
// (packages/agent/src/spawn.ts, `sibling`), so the recorded call IS the claim, and no id parsing is
// needed to find it. Ids the map does not hold are calls to other packages and claim nothing
// (projections.test.ts, "a package call to a non-thread claims nothing").
//
// Roots are the threads no log claims, sorted by first event time; children sort the same way, so
// two runs of the same forest render identically (projections.test.ts, "three levels, two roots").
export const treeOf = (logs: ReadonlyMap<string, ReadonlyArray<Event>>): ReadonlyArray<ThreadNode> => {
  const parents = new Map<string, string>()
  for (const [id, events] of logs) {
    for (const event of events) {
      if (event.type !== "PackageCalled") continue
      const callId = String((event as { callId?: unknown }).callId ?? "")
      if (callId === id || !logs.has(callId) || parents.has(callId)) continue
      parents.set(callId, id)
    }
  }
  const order = (a: string, b: string): number =>
    (firstAt(logs.get(a) ?? []) - firstAt(logs.get(b) ?? [])) || (a < b ? -1 : a > b ? 1 : 0)
  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of parents) {
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [child])
    else siblings.push(child)
  }
  // A claim cycle is not reachable through minted call ids, but the map is an argument, so the walk
  // carries the guard rather than trusting its caller.
  const walked = new Set<string>()
  const node = (id: string, parent?: string): ThreadNode => {
    walked.add(id)
    const events = logs.get(id) ?? []
    const children = (childrenOf.get(id) ?? []).filter((child) => !walked.has(child)).sort(order)
    return { ...summaryOf(id, events, parent), children: children.map((child) => node(child, id)) }
  }
  return [...logs.keys()].filter((id) => !parents.has(id)).sort(order).map((id) => node(id))
}

// TurnStatus is the turn vocabulary of GET /v1/actors/:actor/threads/:id/turns. `parked` is the budget ask nobody can
// answer over HTTP (apps-server-spec.md, "Explicitly out of scope": budget escalation).
export type TurnStatus = "pending" | "completed" | "failed" | "parked"

export interface TurnView {
  readonly turn: string
  readonly status: TurnStatus
  readonly output?: string
  readonly error?: string
}

// turnsOf projects one turn per inbound message, in the order the messages arrived. `at` cuts the
// log to a prefix first: any prefix of a log is a valid state, so time travel is this one argument
// and never a stored mode (apps-server-spec.md, "Principles"). A prefix taken before a turn's
// terminal reads that turn pending again (projections.test.ts, "a prefix takes a turn back to
// pending"), and a prefix taken before a message drops its turn from the list entirely.
export const turnsOf = (events: ReadonlyArray<Event>, at?: number): ReadonlyArray<TurnView> => {
  const prefix = events.slice(0, at ?? events.length)
  return inboundOf(prefix).map((turn): TurnView => {
    const boundary = boundaryOf(prefix, turn)
    if (boundary === undefined) return { turn, status: "pending" }
    if (boundary.kind === "completed") return { turn, status: "completed", output: boundary.output }
    if (boundary.kind === "failed") return { turn, status: "failed", error: boundary.error }
    // A park is neither an output nor an error: the turn is alive and waiting on an answer the API
    // has no door for, so the status carries the whole of what a client can act on.
    return { turn, status: "parked" }
  })
}
