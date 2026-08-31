import type { ActorThreadsEvent, ActorThread } from "@clavia/tardigrade-client"

export const applyActorEvent = (
  current: ReadonlyArray<ActorThread>,
  event: ActorThreadsEvent
): ReadonlyArray<ActorThread> => {
  if (event.type === "ThreadsSnapshot") return event.threads
  if (current.some((thread) => thread.id === event.thread.id)) return current
  return [...current, event.thread]
}
