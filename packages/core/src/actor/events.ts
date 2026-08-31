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

export type ActorEvent = ThreadRequested | ActorThreadCreated

export interface ActorThreadRecord {
  readonly thread: string
  readonly parentThread?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly state: "requested" | "created"
}

export const actorEventKeyOf = (event: Event): string | undefined => {
  if (event.type === "ThreadRequested" && typeof event.thread === "string") return `thread:requested:${event.thread}`
  if (event.type === "ThreadCreated" && typeof event.thread === "string") return `thread:created:${event.thread}`
  return undefined
}

export const actorEventsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorEvent> =>
  events.filter((event): event is ActorEvent => {
    if (typeof event.thread !== "string") return false
    return event.type === "ThreadRequested" || event.type === "ThreadCreated"
  })

export const actorThreadsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorThreadRecord> => {
  const entries = new Map<string, ActorThreadRecord>()
  for (const event of actorEventsOf(events)) {
    if (event.type === "ThreadRequested") {
      entries.set(event.thread, {
        thread: event.thread,
        ...(event.parentThread === undefined ? {} : { parentThread: event.parentThread }),
        depth: event.depth,
        ...(event.placement === undefined ? {} : { placement: event.placement }),
        state: "requested"
      })
      continue
    }
    const current = entries.get(event.thread)
    if (current === undefined) throw new Error(`thread ${JSON.stringify(event.thread)} has no request`)
    entries.set(event.thread, { ...current, state: "created" })
  }
  return [...entries.values()].sort((left, right) => left.thread.localeCompare(right.thread))
}
