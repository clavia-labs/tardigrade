import type { Event } from "@clavia/tardigrade-core/event"
import { formatActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { threadCreatedOf } from "@clavia/tardigrade-core/thread"
import { REPLY_SUFFIX } from "@clavia/tardigrade-core/message"
import { canProgress, factsOf } from "@clavia/tardigrade-code/projections"
import { boundaryOf } from "tardie/boundary"

// The read side of the API. Every endpoint that answers a question about a thread answers it here,
// as a pure function of that thread's events (apps-server-spec.md, "Principles": every read is a
// projection of the log). Nothing in this module touches a store, a host, or a clock, so a route is
// a lookup plus one of these calls, and a test is an array of events.
//
// The projections read the framework's own projections wherever one already answers the question:
// the lane's owed work comes from the code lane (@clavia/tardigrade-code/projections), and a turn's
// outcome comes from the thread's boundary (tardie/boundary). The vocabulary the wire
// speaks is the only thing added here.

// ThreadStatus is the summary vocabulary of GET /v1/threads. Four answers, in the order they are
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
export const inboundOf = (events: ReadonlyArray<Event>): ReadonlyArray<string> => {
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
// nothing is owed (apps-server-spec.md, "GET /v1/threads").
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

// ThreadSummary is one row of GET /v1/threads: what a thread is, without its events. `parent` is absent
// for a root, and `lastAt` for a thread whose events carry no timestamp.
export interface ThreadSummary {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly events: number
  readonly lastAt?: number
  readonly status: ThreadStatus
}

// summaryOf projects one created thread log into its row. The child's creation event supplies depth, while treeOf resolves its parent address to the API id in this listing.
export const summaryOf = (id: string, events: ReadonlyArray<Event>, parent?: string): ThreadSummary => {
  const created = threadCreatedOf(events)
  if (created === undefined) throw new Error(`thread ${JSON.stringify(id)} has no ThreadCreated first event`)
  let lastAt: number | undefined
  for (const event of events) {
    const at = numberAt(event)
    if (at !== undefined) lastAt = at
  }
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    depth: created.depth,
    events: events.length,
    ...(lastAt === undefined ? {} : { lastAt }),
    status: statusOf(events)
  }
}

// ThreadNode is a summary with the threads it spawned, the shape GET /v1/threads/:id/tree serves.
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

// treeOf builds the forest from each log's ThreadCreated record. Address lookup resolves parentage without reading a lane grammar or correlating package call ids (tla/runtime/Thread.tla, AcceptedMatchesCreated).
export const treeOf = (logs: ReadonlyMap<string, ReadonlyArray<Event>>): ReadonlyArray<ThreadNode> => {
  const idsByAddress = new Map<string, string>()
  for (const [id, events] of logs) {
    const created = threadCreatedOf(events)
    if (created === undefined) throw new Error(`thread ${JSON.stringify(id)} has no ThreadCreated first event`)
    const address = formatActorId(created.address)
    if (idsByAddress.has(address)) throw new Error(`thread address ${JSON.stringify(address)} appears in more than one log`)
    idsByAddress.set(address, id)
  }
  const parents = new Map<string, string>()
  for (const [id, events] of logs) {
    const parentAddress = threadCreatedOf(events)!.parent
    if (parentAddress === undefined) continue
    const parent = idsByAddress.get(formatActorId(parentAddress))
    if (parent !== undefined && parent !== id) parents.set(id, parent)
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
