import { restingActor } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { IngressActor } from "@clavia/tardigrade-host/transport/ingress"
import type { Directory } from "@clavia/tardigrade-core/transport/directory"
import { resolveThreadId } from "@clavia/tardigrade-host/thread-compat"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime/actor"
import { Clock, Effect } from "effect"
import { join } from "node:path"
import type { Actor } from "@clavia/tardigrade-core/actor/definition"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { actorClient, type ActorClient } from "@clavia/tardigrade-core/actor/client"
import type { CallOptions } from "@clavia/tardigrade-core/actor/client"
import type { InvocationCoordinate } from "@clavia/tardigrade-core/interaction/invocation"
import type { ActorMethodState } from "@clavia/tardigrade-core/interaction/state"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { isActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { threadCreated, threadCreatedOf, childLineageOf } from "@clavia/tardigrade-core/interaction/relations"
import { formatThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { existingInvocation, prepareMethodInvocation } from "@clavia/tardigrade-host/invocation"
import { bunInstances } from "./instances"
import { createBunHost as createBunInstance, type BunHost, type BunHostOptions } from "./host"

export type HostOptions<R, Methods extends ActorMethods> = Omit<BunHostOptions<R>, "database" | "actorName" | "actorInstance" | "actorFor" | "initializeRoot" | "layersFor" | "signal"> & {
  readonly actor: Actor<R, Methods>
  readonly storage: string
  readonly storageLayout?: HostStorageLayout
} & {
  [K in keyof Pick<BunHostOptions<R>, "layersFor">]: (thread: string, instance: string) => ReturnType<NonNullable<BunHostOptions<R>["layersFor"]>>
}

// HostStorageLayout preserves existing instance database names when a host mounts stored actors.
export interface HostStorageLayout {
  readonly databaseFor: (instance: string) => string
  readonly instanceFromFile: (file: string) => string | undefined
}

export interface Host<Methods extends ActorMethods> extends ActorClient<Methods> {
  readonly actor: string
  readonly close: () => Promise<void>
}

export interface HostBackend {
  readonly actor: string
  readonly methods: ActorMethods
  readonly storage: string
  readonly resting: (events: ReadonlyArray<Event>) => boolean
  readonly instances: ReadonlyMap<string, BunHost>
  readonly ensure: (instance: string) => Promise<BunHost>
  readonly resolve: Directory<ThreadCoordinate, IngressActor>["resolve"]
  readonly allocate: (request: ThreadAllocation) => Promise<ThreadCoordinate>
  readonly submit: (coordinate: ThreadCoordinate, name: string, input: unknown, call: CallOptions) => Promise<ReturnType<typeof prepareMethodInvocation>["accepted"]>
  readonly state: (reference: InvocationCoordinate) => Promise<ActorMethodState<unknown> | undefined>
}

const backends = new WeakMap<object, HostBackend>()

export const hostBackend = (host: object): HostBackend => {
  const backend = backends.get(host)
  if (backend === undefined) throw new Error("serve requires a Bun host")
  return backend
}

// createBunHost owns the Bun runtimes and SQLite files for an actor's instances.
export const createBunHost = async <R, const Methods extends ActorMethods>(options: HostOptions<R, Methods>): Promise<Host<Methods>> => {
  if (!options.storage) throw new Error("storage must be a directory or :memory:")
  const actorOf = (name: string): Actor<R, Methods> => {
    if (name !== options.actor.name) throw new Error("target actor does not match this host")
    return options.actor
  }
  const pool = bunInstances<BunHost>({
    recover: (host: BunHost) => host.recover(),
    open: (instance, signal) => createBunInstance<R>({
      ...options, signal,
      keyOf: options.keyOf ?? actorRuntimeOf(options.actor).keyOf,
      layersFor: options.layersFor === undefined ? undefined : (thread: string) => options.layersFor!(thread, instance),
      database: options.storageLayout?.databaseFor(instance) ?? (options.storage === ":memory:" ? ":memory:" : join(options.storage, Buffer.from(JSON.stringify([options.actor.name, instance])).toString("base64url") + ".sqlite")),
      actorName: options.actor.name, actorInstance: instance, actorFor: () => options.actor,
      threadAllocator: options.threadAllocator ?? { allocate: (request) => Effect.promise(async () => {
        const target = request.kind === "root" ? request.coordinate : request.parent
        return (await instanceOf(target.actor, target.instance)).assignThread(request)
      }) },
      initializeRoot: async (target, at) => (await instanceOf(target.actor, target.instance)).initializeRoot(target, at),
      routes: [...(options.routes ?? []), {
        transport: "host-instances",
        resolve: (envelope) => Effect.succeed(isActorEnvelope(envelope) && envelope.link.target.actor === options.actor.name && envelope.link.target.instance !== instance
          ? () => Effect.promise(async () => { const destination = await instanceOf(envelope.link.target.actor, envelope.link.target.instance); await destination.commit(envelope); pool.track(destination.drive()) }) : undefined)
      }]
    } as BunHostOptions<R>)
  })
  const active = () => pool.signal.throwIfAborted()
  const instanceOf = (actorName: string, instance: string): Promise<BunHost> => {
    actorOf(actorName)
    if (!instance) throw new Error("instance must not be empty")
    return pool.open(instance)
  }
  const allocate = async (request: ThreadAllocation): Promise<ThreadCoordinate> => {
    active()
    const scope = request.kind === "root" ? request.coordinate : request.parent
    const host = await instanceOf(scope.actor, scope.instance)
    if (request.kind === "root") return host.allocate(request)
    const parent = threadCreatedOf(await host.read(request.parent.thread))
    if (parent === undefined) throw new Error("parent thread does not exist")
    const target = await host.allocate(request)
    const lineage = childLineageOf(parent, options.defaultChildPlacement)
    await host.commit({ link: { source: request.parent, target }, lineage, event: threadCreated(target, lineage, Date.now()) })
    return target
  }
  const resolve: HostBackend["resolve"] = (target) => target.actor !== options.actor.name
    ? Effect.succeed(undefined as IngressActor | undefined)
    : Effect.map(Effect.promise(() => instanceOf(target.actor, target.instance)), (runtime) => ({
      commit: (envelope) => Effect.gen(function*() {
        const thread = yield* resolveThreadId(envelope.link.target.thread, (id) => Effect.promise(async () => (await runtime.actorThread(id)) !== undefined))
        const at = yield* Clock.currentTimeMillis
        yield* Effect.promise(() => runtime.commit({
          ...envelope, link: { ...envelope.link, target: { ...target, thread } },
          event: envelope.event.at === undefined ? { ...envelope.event, at } : envelope.event
        }))
      }),
      schedule: Effect.sync(() => { for (const instance of pool.instances.values()) instance.schedule() })
    }))
  const backend: HostBackend = {
    actor: options.actor.name,
    methods: options.actor.methods,
    storage: options.storage,
    resting: (events) => restingActor(options.actor, events),
    instances: pool.instances,
    ensure: (instance) => instanceOf(options.actor.name, instance),
    resolve,
    allocate,
    submit: async (coordinate, name, input, call) => {
      active()
      call.signal?.throwIfAborted()
      const host = await instanceOf(coordinate.actor, coordinate.instance)
      const method = actorOf(coordinate.actor).methods[name]
      if (method === undefined) throw new Error("unknown method")
      const events = await host.read(coordinate.thread)
      if (threadCreatedOf(events) === undefined) throw new Error("thread does not exist")
      const reference = { target: coordinate, invocation: { method: name, id: call.key, epoch: method.currentEpoch(events, call.key) } }
      let receipt = existingInvocation(events, reference)
      if (receipt === undefined) {
        const prepared = prepareMethodInvocation({ reference, method, input, at: Date.now(), ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }) })
        await host.commitRoot(formatThreadAddress(coordinate), prepared.event)
        receipt = prepared.accepted
      }
      pool.track(host.drive())
      return receipt
    },
    state: async (reference) => {
      active()
      const method = actorOf(reference.target.actor).methods[reference.invocation.method]
      if (method === undefined) throw new Error("unknown method")
      return method.state(await (await instanceOf(reference.target.actor, reference.target.instance)).read(reference.target.thread), reference.invocation)
    }
  }
  const client = actorClient(options.actor, {
    allocate,
    invoke: async (coordinate, name, input, call) => {
      const receipt = await backend.submit(coordinate, name, input, call)
      const reference = receipt.reference
      const method = actorOf(coordinate.actor).methods[name]!
      const host = await instanceOf(coordinate.actor, coordinate.instance)
      const signal = AbortSignal.any([pool.signal, ...(call.signal === undefined ? [] : [call.signal])])
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error("actor call deadline exceeded")), Math.max(0, receipt.deadlineAt - Date.now()))
      const waiting = AbortSignal.any([signal, controller.signal])
      try {
        for (;;) {
          signal.throwIfAborted()
          const log = await host.read(coordinate.thread)
          const state = method.state(log, reference.invocation)
          if (state?.status === "completed") return state.output
          if (state?.status === "failed") throw new Error(state.error)
          if (state?.status === "cancelled") throw new Error(state.reason ?? `actor call cancelled: ${state.cause}`)
          await host.awaitHead(coordinate.thread, log.length, waiting)
        }
      } catch (error) {
        waiting.throwIfAborted()
        throw error
      } finally { clearTimeout(timeout) }
    }
  })
  const host: Host<Methods> = {
    ...client, actor: options.actor.name,
    close: pool.close
  }
  if (options.storage !== ":memory:") await pool.restore(options.storage, options.storageLayout?.instanceFromFile ?? ((file) => {
    if (!file.endsWith(".sqlite")) return undefined
    let identity: unknown
    try { identity = JSON.parse(Buffer.from(file.slice(0, -7), "base64url").toString("utf8")) } catch { return undefined }
    return Array.isArray(identity) && identity.length === 2 && identity[0] === options.actor.name && typeof identity[1] === "string" ? identity[1] : undefined
  }))
  backends.set(host, backend)
  return host
}

// createHost preserves the original Bun host factory name.
export const createHost: typeof createBunHost = (options) => createBunHost(options)
