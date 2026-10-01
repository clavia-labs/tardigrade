import { Effect } from "effect"
import { createActorStore, type ActorMethods, type ActorRuntime } from "@clavia/tardigrade-experimental-core"

// createTestStore captures runtime admission for properties that inject domain histories directly.
export function createTestStore<Event extends object, State, Services, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Parameters<typeof createActorStore<Event, State, Services, Contracts>>[0]) {
  return Effect.gen(function* () {
    let runtime!: ActorRuntime<Event>
    const store = yield* createActorStore({ ...options, services: current => {
      runtime = current
      return options.services(current)
    } })
    return { ...store, send: runtime.send }
  })
}
