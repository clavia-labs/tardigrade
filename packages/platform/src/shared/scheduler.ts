import { Effect, Scheduler } from "effect"

// hostScheduler resumes fibers on the microtask queue; the default scheduler spends a workerd event-loop turn per fiber hop. Fibers still suspend on I/O.
const hostScheduler: Scheduler.Scheduler = new Scheduler.MixedScheduler("sync")

// onHostScheduler runs an effect, and every fiber it forks, on hostScheduler.
export const onHostScheduler = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.provideService(effect, Scheduler.Scheduler, hostScheduler)
