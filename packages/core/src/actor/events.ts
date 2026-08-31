import type { Event } from "../log/event"
import type { ChildPlacement } from "../thread/lineage"

export interface ThreadRequested extends Event {
  readonly type: "ThreadRequested"
  readonly thread: string
  readonly parentThread?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly at: number
}

export interface ActorThreadCreated extends Event {
  readonly type: "ThreadCreated"
  readonly thread: string
  readonly at: number
}

export interface ThreadCommitted extends Event {
  readonly type: "ThreadCommitted"
  readonly thread: string
  readonly after?: number
  readonly head: number
  readonly at: number
}

export type ActorEvent = ThreadRequested | ActorThreadCreated | ThreadCommitted

export interface ActorThreadRecord {
  readonly thread: string
  readonly parentThread?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly state: "requested" | "created"
  readonly head: number
}

export const actorEventKeyOf = (event: Event): string | undefined => {
  if (event.type === "ThreadRequested" && typeof event.thread === "string") return `thread:requested:${event.thread}`
  if (event.type === "ThreadCreated" && typeof event.thread === "string") return `thread:created:${event.thread}`
  if (event.type === "ThreadCommitted" && typeof event.thread === "string" && typeof event.head === "number") {
    return `thread:committed:${event.thread}:${typeof event.after === "number" ? event.after : event.head}`
  }
  return undefined
}

export const actorEventsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorEvent> =>
  events.filter((event): event is ActorEvent => {
    if (typeof event.thread !== "string") return false
    if (event.type === "ThreadRequested" || event.type === "ThreadCreated") return true
    return event.type === "ThreadCommitted" && typeof event.head === "number"
  })

export const actorThreadsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorThreadRecord> => {
  const entries = new Map<string, ActorThreadRecord>()
  const heads = new Map<string, number>()
  for (const event of actorEventsOf(events)) {
    if (event.type === "ThreadCommitted") {
      heads.set(event.thread, Math.max(heads.get(event.thread) ?? 0, event.head))
      continue
    }
    if (event.type === "ThreadRequested") {
      entries.set(event.thread, {
        thread: event.thread,
        ...(event.parentThread === undefined ? {} : { parentThread: event.parentThread }),
        depth: event.depth,
        ...(event.placement === undefined ? {} : { placement: event.placement }),
        state: "requested",
        head: heads.get(event.thread) ?? 0
      })
      continue
    }
    const current = entries.get(event.thread)
    if (current === undefined) throw new Error(`thread ${JSON.stringify(event.thread)} has no request`)
    entries.set(event.thread, { ...current, state: "created" })
  }
  for (const [thread, head] of heads) {
    const current = entries.get(thread)
    if (current !== undefined) entries.set(thread, { ...current, head })
  }
  return [...entries.values()].sort((left, right) => left.thread.localeCompare(right.thread))
}
