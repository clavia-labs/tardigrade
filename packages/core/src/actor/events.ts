import type { Event } from "@clavia/tardigrade-core/event"
import type { ThreadAllocation } from "./allocation"
import type { ChildPlacement } from "../interaction/relations"
import { upcastThreadRequest } from "./log/upcast"

export interface ThreadRequested extends Event {
  readonly type: "ThreadRequested"
  readonly allocationRequest?: ThreadAllocation
  readonly allocationKey?: string
  readonly thread: string
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
  readonly allocationRequest?: ThreadAllocation
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
    return event.type === "ThreadRequested" || event.type === "ThreadRegistered" ? [event as ActorEvent] : []
  })

export const actorThreadsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ActorThreadRecord> => {
  const entries = new Map<string, ActorThreadRecord>()
  for (const event of actorEventsOf(events)) {
    const current = entries.get(event.thread)
    if (event.type === "ThreadRequested") {
      const { parentThread, placement, depth } = upcastThreadRequest(event)
      const parent = parentThread === undefined ? undefined : entries.get(parentThread)
      if (parentThread !== undefined && parent === undefined && depth === undefined) {
        throw new Error(`thread ${JSON.stringify(event.thread)} has no parent record ${JSON.stringify(parentThread)}`)
      }
      entries.set(event.thread, {
        ...(event.allocationRequest === undefined ? {} : { allocationRequest: event.allocationRequest }),
        ...(event.allocationKey === undefined ? {} : { allocationKey: event.allocationKey }),
        thread: event.thread,
        ...(parentThread === undefined ? {} : { parentThread }),
        depth: depth ?? (parent === undefined ? 0 : parent.depth + 1),
        ...(placement === undefined ? {} : { placement }),
        state: "requested"
      })
      continue
    }
    if (current === undefined) throw new Error(`thread ${JSON.stringify(event.thread)} has no request`)
    entries.set(event.thread, { ...current, ...(event.placement === undefined ? {} : { placement: event.placement }), state: "registered" })
  }
  return [...entries.values()]
}
