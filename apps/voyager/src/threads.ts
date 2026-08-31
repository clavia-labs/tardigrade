import type { ActorStreamEvent, ThreadSummary } from "@clavia/tardigrade-client"

export const applyActorEvent = (
  current: ReadonlyArray<ThreadSummary>,
  event: ActorStreamEvent
): ReadonlyArray<ThreadSummary> => {
  if (event.type === "ThreadsSnapshot") return event.threads
  const index = current.findIndex((thread) => thread.id === event.thread.id)
  if (index < 0) return [...current, event.thread]
  return current.map((thread, at) => at === index ? event.thread : thread)
}
