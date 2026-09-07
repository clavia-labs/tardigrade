import type { Event } from "@clavia/tardigrade-core/event"
import type { ChildPlacement } from "../interaction/relations"

export interface ThreadRequested extends Event {
  readonly type: "ThreadRequested"
  readonly allocationKey?: string
  readonly thread: string
  readonly parentThread?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly at: number
}

export interface ThreadRegistered extends Event {
  readonly type: "ThreadRegistered"
  readonly placement?: ChildPlacement
  readonly thread: string
  readonly at: number
}

export type ActorEvent = ThreadRequested | ThreadRegistered

export interface ActorThreadRecord {
  readonly allocationKey?: string
  readonly thread: string
  readonly parentThread?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly state: "requested" | "registered"
}

export const actorEventKeyOf = (event: Event): string | undefined => {
  if (event.type === "ThreadRequested" && typeof event.thread === "string") return `thread:requested:${event.thread}`
  if (event.type === "ThreadRegistered" && typeof event.thread === "string") return `thread:registered:${event.thread}`
  return undefined
}

export const actorEventsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorEvent> =>
  events.flatMap((event): ReadonlyArray<ActorEvent> => {
    if (typeof event.thread !== "string") return []
    if (event.type === "ThreadAllocated") return [{ ...event, type: "ThreadRequested" } as ThreadRequested]
    return event.type === "ThreadRequested" || event.type === "ThreadRegistered" ? [event as ActorEvent] : []
  })

export const actorThreadsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorThreadRecord> => {
  const entries = new Map<string, ActorThreadRecord>()
  for (const event of actorEventsOf(events)) {
    const current = entries.get(event.thread)
    if (event.type === "ThreadRequested") {
      const allocationKey = event.allocationKey ?? current?.allocationKey
      entries.set(event.thread, {
        ...current,
        ...(allocationKey === undefined ? {} : { allocationKey }),
        thread: event.thread,
        ...(event.parentThread === undefined ? {} : { parentThread: event.parentThread }),
        depth: event.depth,
        ...(event.placement === undefined ? {} : { placement: event.placement }),
        state: current?.state ?? "requested"
      })
      continue
    }
    if (current === undefined) throw new Error(`thread ${JSON.stringify(event.thread)} has no request`)
    entries.set(event.thread, { ...current, ...(event.placement === undefined ? {} : { placement: event.placement }), state: "registered" })
  }
  return [...entries.values()]
}
