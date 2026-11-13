import { Layer } from "effect"
import type { ActorDefinition, ActorMethods, EventLog, Invocation, Supervisor } from "@clavia/tardigrade-core"
import { createBunHost } from "./runtime"

type HostOptions<Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Parameters<typeof createBunHost<Event, Services, State, Contracts>>[0]
type HostServices<Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Layer.Success<ReturnType<HostOptions<Event, Services, State, Contracts>["services"]>>

// host constructs an actor's services within each runtime's lifetime.
export function host<Event extends object, Services, State, Contracts extends ActorMethods<Event>, Provided = never, Required = never>(
  actor: ActorDefinition<Event, State, Services, Contracts, Provided, Required>,
  options: Omit<HostOptions<Event, Services, State, Contracts>, "actor" | "services" | "actorContext"> & {
    readonly layer: Layer.Layer<Exclude<HostServices<Event, Services, State, Contracts>, NoInfer<Provided>> | NoInfer<Required>, Error, Supervisor | Invocation | EventLog>
  },
) {
  const { layer, ...settings } = options
  const { layer: actorLayer, actorContext, ...definition } = actor
  const services = actorLayer ? actorLayer.pipe(Layer.provideMerge(layer)) : layer
  return createBunHost<Event, Services, State, Contracts>({
    ...settings,
    actor: definition,
    actorContext: actorContext ?? (context => context),
    services: () => services as Layer.Layer<HostServices<Event, Services, State, Contracts>, Error, Supervisor | Invocation | EventLog>,
  })
}
