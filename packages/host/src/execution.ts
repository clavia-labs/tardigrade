import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf, createActorReconciler, restingActor, type ActorSource } from "@clavia/tardigrade-core/runtime"

// actorExecution retains reconciliation state between drives (platform/cloudflare/test/actor.workers.ts).
export const actorExecution = <R>(actor: ActorSource<R>) => {
  const reconciler = createActorReconciler(actorRuntimeOf(actor))
  let settled = false
  return {
    settle: reconciler.settle.pipe(Effect.tap(() => Effect.sync(() => { settled = true }))),
    isResting: (read: Effect.Effect<ReadonlyArray<Event>>) => Effect.suspend(() => settled
      ? Effect.sync(() => reconciler.isResting())
      : Effect.map(read, (events) => restingActor(actor, events)))
  }
}

// threadExecutions replaces cached execution when a thread's actor definition changes (platform/bun/src/host.test.ts).
export const threadExecutions = <R>() => {
  const entries = new Map<string, { readonly actor: ActorSource<R>; readonly execution: ReturnType<typeof actorExecution<R>> }>()
  return (thread: string, actor: ActorSource<R>) => {
    let entry = entries.get(thread)
    if (entry?.actor !== actor) {
      entry = { actor, execution: actorExecution(actor) }
      entries.set(thread, entry)
    }
    return entry.execution
  }
}
