import { Effect, type Layer } from "effect"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { actorEventKeyOf } from "@clavia/tardigrade-core/actor/events"
import { ThreadProvisioner, type ThreadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/log"
import { actorRuntimeOf, settleActor, type Self } from "@clavia/tardigrade-core/runtime"
import type { Router } from "@clavia/tardigrade-core/transport/router"
import { hostDrive } from "./driver"

export const threadSupervisorKeyOf = (supervisor: ThreadSupervisor | undefined, event: Event): string | undefined =>
  actorEventKeyOf(event) ?? (supervisor === undefined ? undefined : actorRuntimeOf(supervisor).keyOf(event))

// threadSupervisorDriver invokes the supervisor over the owning actor directory (thread-supervisor.test.ts).
export const threadSupervisorDriver = (
  supervisor: ThreadSupervisor,
  log: typeof EventLog.Service,
  provisioner: Layer.Layer<ThreadProvisioner>,
  run: <A>(operation: Effect.Effect<A, never, Router | Self>) => Promise<A>
) => {
  const { drive } = hostDrive(() => run(settleActor(supervisor).pipe(
    Effect.provideService(EventLog, log), Effect.provide(provisioner)
  )))
  return {
    drive,
    ensureReady: async (target: ThreadCoordinate): Promise<ThreadCoordinate> => {
      const invocation = { method: "requestThread", id: target.thread, epoch: 0 }
      const method = supervisor.methods.requestThread
      const events = await run(log.read)
      const before = method.state(events, invocation)
      if (before === undefined) throw new Error("thread creation requires an allocation reservation")
      if (before?.status !== "completed") await drive()
      const state = method.state(await run(log.read), invocation)
      if (state?.status !== "completed") throw new Error(`thread ${target.thread} is not ready`)
      if (state.output !== target.thread) {
        throw new Error("thread supervisor returned a different coordinate")
      }
      return target
    }
  }
}
