import type { InitialState } from "../initial-state"
import { prepareInitialState } from "./initialisation"
import type { ThreadCoordinate, ChildPlacement } from "../actor/thread"
import type { ActorMethods } from "../actor/method"
import { RuntimeError } from "./effects"
import type { Journal } from "../services/journal"
import type { MessageSender } from "../actor/message"
import type { SupervisorEvent } from "../services/supervisor/graph"
import { Effect, Layer, Scope, Exit, Fiber } from "effect"
import { createActorExecution, type ActorExecutionOptions, type ActorStorage } from "./actors"
import { Supervisor, createSupervisor } from "../services/supervisor"
import { Invocation, createInvocation, DEFAULT_EXTERNAL_SENDER, type MessageTransport, type ActorMessageTransport } from "../services/invocation"

export interface ThreadStorage<Event extends object> extends ActorStorage<Event> {
  readonly supervisor: (actor: string, instance: string) => Journal<SupervisorEvent>
  readonly close: Effect.Effect<void, Error>
}

export const HOST_CHILD_PLACEMENTS = ["colocated"] as const satisfies readonly ChildPlacement[]
export const DEFAULT_CHILD_PLACEMENT: ChildPlacement = "colocated"

// createThreadHost composes supervision and invocation within a shared storage lifetime.
export function createThreadHost<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: Omit<ActorExecutionOptions<Event, Services, State, Contracts>, "from" | "delivery"> & {
  readonly storage: ThreadStorage<Event>
  readonly from?: MessageSender
  readonly actorTransport?: ActorMessageTransport
  readonly transports?: Readonly<Record<string, MessageTransport>>
  readonly delivery?: { readonly retryIntervalMs?: number }
  readonly generateName?: () => string
  readonly defaultChildPlacement?: ChildPlacement
}) {
  const scope = Scope.makeUnsafe()
  let closed = false
  const check = Effect.suspend(() => closed ? Effect.fail(new RuntimeError("Thread host is closed")) : Effect.void)
  const run = <Value>(work: Effect.Effect<Value, Error>) => check.pipe(Effect.andThen(Effect.acquireUseRelease(work.pipe(Effect.forkIn(scope)), Fiber.join, Fiber.interrupt)))
  const supervisor = createSupervisor({
    actor: options.actor.actorName,
    journal: instance => options.storage.supervisor(options.actor.actorName, instance),
    validateInitialState: state => prepareInitialState(options.initialStateAtoms ?? [], state).pipe(Effect.asVoid),
    provision: allocation => actors.provision({
      type: "ThreadCreated", address: allocation.coordinate,
      parent: allocation.parent === null ? null : { ...allocation.coordinate, thread: allocation.parent },
      depth: allocation.depth, placement: allocation.placement,
    }, allocation.initialState),
    defaultChildPlacement: options.defaultChildPlacement ?? DEFAULT_CHILD_PLACEMENT,
    supportedChildPlacements: HOST_CHILD_PLACEMENTS,
    ...(options.generateName ? { generateName: options.generateName } : {}),
    run,
  })
  const actors: ReturnType<typeof createActorExecution<Event, Services, State, Contracts>> = createActorExecution({
    ...options, run, from: options.from ?? DEFAULT_EXTERNAL_SENDER,
    delivery: coordinate => ({ ...options.delivery, address: coordinate, send: invocation.forSender(coordinate).send }),
    services: (coordinate, runtime) => options.services(coordinate, runtime).pipe(Layer.provideMerge(Layer.merge(Layer.succeed(Supervisor, supervisor), Layer.succeed(Invocation, invocation.forSender(coordinate))))),
  })
  const invocation = createInvocation({ supervisor, reference: actors.reference, receive: actors.receive, from: options.from ?? DEFAULT_EXTERNAL_SENDER, ...(options.actorTransport ? { actorTransport: options.actorTransport } : {}), ...(options.transports ? { transports: options.transports } : {}), run })
  const closing = Effect.runSync(Effect.cached(Effect.gen(function* () {
    closed = true
    yield* Scope.close(scope, Exit.succeed(undefined))
    const supervisorResult = yield* Effect.exit(supervisor.close)
    const actorResult = yield* Effect.exit(actors.close)
    yield* options.storage.close
    const failure = [supervisorResult, actorResult].find(Exit.isFailure)
    if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
  }).pipe(Effect.uninterruptible)))
  return {
    actor: options.actor.actorName,
    supervisorStore: supervisor.store,
    getThread: (input: { readonly instance: string; readonly thread: string }) => invocation.get({ actor: options.actor.actorName, ...input }),
    send: invocation.send,
    receive: invocation.receive,
    allocateRootThread: (input: { readonly instance: string; readonly name?: string; readonly placement?: ChildPlacement; readonly initialState?: InitialState }) => run(supervisor.allocate(input).pipe(Effect.flatMap(actors.reference))),
    allocateChildThread: (input: { readonly parent: ThreadCoordinate; readonly name?: string; readonly placement?: ChildPlacement; readonly initialState?: InitialState }) => run(supervisor.allocate({ instance: input.parent.instance, ...input }).pipe(Effect.flatMap(actors.reference))),
    close: closing,
  }
}
