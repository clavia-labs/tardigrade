import { ProblemError, type Event, type EventRow } from "@clavia/tardigrade-client"

import { actor, client } from "./chat-client"

const ACTOR_THREAD_PREFIX = "ag."

export const childThread = (event: Event): string | undefined => {
  const address = event.address
  if (typeof address !== "object" || address === null || !("thread" in address)) return undefined
  const thread = address.thread
  return typeof thread === "string" && thread.startsWith(ACTOR_THREAD_PREFIX)
    ? thread.slice(ACTOR_THREAD_PREFIX.length)
    : undefined
}

export const mergeEvents = (current: ReadonlyArray<EventRow>, row: EventRow): ReadonlyArray<EventRow> =>
  current.some((item) => item.seq === row.seq) ? current : [...current, row].sort((a, b) => a.seq - b.seq)

export const readEvents = async (id: string): Promise<ReadonlyArray<EventRow>> => {
  try {
    return await client.events(actor, id)
  } catch (error) {
    if (error instanceof ProblemError && error.status === 404) return []
    throw error
  }
}

export const toolContent = (event: Event): string => {
  const args = event.arguments
  if (typeof args === "object" && args !== null && "code" in args && typeof args.code === "string") return args.code
  return JSON.stringify(args, undefined, 2) ?? ""
}

export const toolTitle = (event: Event, complete: boolean): string => {
  const name = value(event, "name") ?? "tool"
  if (name === "execute") return complete ? "Executed code" : "Executing code"
  const [packageName, methodName] = name.split(".", 2)
  const target = methodName === undefined ? packageName : `${packageName} · ${methodName}`
  return complete ? `Called ${target}` : `Calling ${target}`
}

export const value = (event: Event, field: string): string | undefined =>
  typeof event[field] === "string" ? event[field] : undefined

export const waitingForResponse = (events: ReadonlyArray<EventRow>): boolean => {
  const started = events.findLastIndex(({ event }) => event.type === "ModelCalled")
  if (started === -1) return false
  return !events.slice(started + 1).some(({ event }) =>
    ["TextReturned", "ToolCalled", "TurnCompleted", "TurnFailed"].includes(event.type)
  )
}
