import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { Context, Layer } from "effect"
import { type ActorDefinition, type ActorMethods, type ActorRuntime, type ThreadCoordinate, type EventLog, type Invocation, type Supervisor } from "@clavia/tardigrade-core"
import type { LibraryImplementation } from "@clavia/tardigrade-libraries"
import { actorContext as agentContext } from "@clavia/tardigrade-agent/actor/context"
import { agentServices } from "@clavia/tardigrade-agent/services/tools"
import { createActorWorker } from "./worker"
import type { ActorObjectOptions } from "./objects"

declare const BindingsTypeId: unique symbol
export interface Bindings<Env extends object> { readonly [BindingsTypeId]: Env }

// Bindings identifies the environment supplied by the Cloudflare host.
export const Bindings = <Env extends object>() => Context.Service<Bindings<Env>, Env>()("tardie/cloudflare/Bindings")

// DurableStorage supplies the storage owned by the Durable Object constructing the layer.
export class DurableStorage extends Context.Service<DurableStorage, DurableObjectStorage>()("tardie/cloudflare/DurableStorage") {}

// HostThread identifies the thread runtime or the temporary $methods inspection runtime.
export class HostThread extends Context.Service<HostThread, ThreadCoordinate>()("tardie/host/Thread") {}

declare const RuntimeTypeId: unique symbol
export interface ThreadRuntime<Event extends object> { readonly [RuntimeTypeId]: (_: Event) => Event }

// ThreadRuntime supplies lifecycle hooks and event delivery for the current runtime.
export const ThreadRuntime = <Event extends object>() => Context.Service<ThreadRuntime<Event>, ActorRuntime<Event>>()("tardie/host/Runtime")

type Libraries = readonly LibraryImplementation<unknown>[]
type Adapters<Selection extends Libraries | undefined> = Selection extends Libraries ? ReturnType<typeof agentServices<Selection>> : Layer.Layer<never>
type Platform<Env extends object, Event extends object> = Bindings<Env> | DurableStorage | HostThread | ThreadRuntime<Event> | Supervisor | Invocation | EventLog
type RuntimeLayer<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>> = ReturnType<ActorObjectOptions<Env, Event, Services, State, Contracts>["services"]>

export type HostOptions<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>, Selection extends Libraries | undefined> =
  & Omit<ActorObjectOptions<Env, Event, Services, State, Contracts>, "actor" | "services">
  & { readonly layer: Layer.Layer<
    Exclude<Layer.Success<RuntimeLayer<Env, Event, Services, State, Contracts>>, Layer.Success<Adapters<Selection>>>
      | Exclude<Layer.Services<Adapters<Selection>>, Platform<Env, Event>>,
    Error,
    Platform<Env, Event>
  > }

// host builds application layers within each runtime scope and derives selected agent tools (test/workerd/host-layer.workers.ts).
export function host<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>, const Selection extends Libraries | undefined = undefined>(
  actor: ActorDefinition<Event, State, Services, Contracts> & { readonly libraries?: Selection } & ([Selection] extends [undefined] ? {} : { readonly libraries: Exclude<Selection, undefined> }),
  options: HostOptions<Env, Event, Services, State, Contracts, Selection>,
) {
  const { layer, ...config } = options
  const adapters = actor.libraries === undefined ? Layer.empty : agentServices({ libraries: actor.libraries })
  return createActorWorker({ ...config, actor,
    ...(options.actorContext !== undefined ? { actorContext: options.actorContext } : actor.libraries === undefined ? {} : { actorContext: agentContext as NonNullable<ActorObjectOptions<Env, Event, Services, State, Contracts>["actorContext"]> }),
    services: (env: Env, coordinate, runtime, storage) => {
      const platform = Layer.mergeAll(
        Layer.succeed(Bindings<Env>(), env),
        Layer.succeed(DurableStorage, storage),
        Layer.succeed(HostThread, coordinate),
        Layer.succeed(ThreadRuntime<Event>(), runtime),
      )
      // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- HostOptions requires the layer to supply adapter inputs; platform injection leaves the outer host services (test/workerd/host-layer.workers.ts).
      return adapters.pipe(Layer.provideMerge(layer), Layer.provide(platform)) as RuntimeLayer<Env, Event, Services, State, Contracts>
    },
  })
}
