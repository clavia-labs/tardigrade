import { Context, Layer } from "effect"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import type { ActorDefinition, ActorMethods, EventLog, Invocation, Supervisor, ThreadCoordinate } from "@clavia/tardigrade-core"
import { createActorWorker } from "./worker"
import type { ActorObjectOptions } from "./objects"

type HostServices<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Layer.Success<ReturnType<ActorObjectOptions<Env, Event, Services, State, Contracts>["services"]>>

declare const BindingsTypeId: unique symbol
export interface Bindings<Env extends object> { readonly [BindingsTypeId]: Env }

// Bindings identifies the environment supplied by the Cloudflare host.
export const Bindings = <Env extends object>() => Context.Service<Bindings<Env>, Env>()("tardie/cloudflare/Bindings")

// DurableStorage supplies the current runtime's Durable Object storage.
export class DurableStorage extends Context.Service<DurableStorage, DurableObjectStorage>()("tardie/cloudflare/DurableStorage") {}

// HostThread identifies the current thread or the temporary methods inspection runtime.
export class HostThread extends Context.Service<HostThread, ThreadCoordinate>()("tardie/host/Thread") {}

type Platform<Env extends object> = Supervisor | Invocation | EventLog | Bindings<Env> | DurableStorage | HostThread

// host constructs an actor's services within each runtime's lifetime.
export function host<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>, Provided = never, Required = never>(
  actor: ActorDefinition<Event, State, Services, Contracts, Provided, Required>,
  options: Omit<ActorObjectOptions<Env, Event, Services, State, Contracts>, "actor" | "services" | "actorContext"> & {
    readonly layer: Layer.Layer<Exclude<HostServices<Env, Event, Services, State, Contracts>, NoInfer<Provided>> | NoInfer<Required>, Error, Platform<Env>>
  },
) {
  const { layer, ...settings } = options
  const { layer: actorLayer, actorContext, ...definition } = actor
  const services = actorLayer ? actorLayer.pipe(Layer.provideMerge(layer)) : layer
  return createActorWorker<Env, Event, Services, State, Contracts>({
    ...settings,
    actor: definition,
    actorContext: actorContext ?? (context => context),
    services: (env, coordinate, _runtime, storage) => services.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(Bindings<Env>(), env),
      Layer.succeed(DurableStorage, storage),
      Layer.succeed(HostThread, coordinate),
    ))) as Layer.Layer<HostServices<Env, Event, Services, State, Contracts>, Error, Supervisor | Invocation | EventLog>,
  })
}
