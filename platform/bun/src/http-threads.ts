import { Ingress, ingressFrom } from "@clavia/tardigrade-host/transport/ingress"
import { DriverGauge } from "@clavia/tardigrade-http/driver-gauge"
import { hostBackend } from "./create-host"
import { Clock, Context, Effect } from "effect"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { childKeyOf, type ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { withLegacyThreadIds } from "@clavia/tardigrade-http/thread-compat"
import { Threads, type ActorThreads } from "@clavia/tardigrade-http/threads"
import type { BunHost } from "./host"

// bunHttpThreads adapts a Bun instance to the HTTP services (create-host.test.ts, apps/cli/src/init-flow.test.ts).
export const bunHttpThreads = (host: BunHost, options: {
  readonly actor: string
  readonly instance: string
  readonly methods: ActorMethods
  readonly storage: ActorThreads["storage"]
  readonly statusOf: ActorThreads["statusOf"]
  readonly allocate: (request: ThreadAllocation) => Promise<ThreadCoordinate>
}): ActorThreads => withLegacyThreadIds({
  methods: options.methods,
  storage: options.storage,
  statusOf: options.statusOf,
  allocateRoot: (name, request = {}) => Effect.promise(async () => {
    if (name !== undefined && request.key !== undefined) throw new Error("named allocations do not accept a separate key")
    // HTTP request identities are minted outside actor replay.
    const key = name === undefined ? { key: request.key ?? crypto.randomUUID() } : {}
    const scope = { actor: options.actor, instance: options.instance }
    const allocation: ThreadAllocation = request.parent === undefined
      ? { kind: "root", coordinate: { ...scope, thread: name ?? "" }, ...key }
      : { kind: "child", parent: { ...scope, thread: request.parent }, child: childKeyOf(name ?? "unnamed"), ...key }
    return options.allocate(allocation)
  }),
  append: (thread, event) => Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.promise(async () => {
    await host.commitRoot(host.self(thread), event.at === undefined ? { ...event, at } : event)
    host.schedule()
  })),
  events: (thread) => Effect.promise(() => host.read(thread)),
  eventsPage: (thread, mark, limit) => Effect.promise(() => host.readPage(thread, mark, limit)),
  awaitHead: (thread, mark) => Effect.promise((signal) => host.awaitHead(thread, mark, signal)),
  actorEventsPage: (mark, limit) => Effect.promise(() => host.readActorPage(mark, limit)),
  actorThreads: Effect.promise(() => host.actorThreads()),
  actorThread: (thread) => Effect.promise(() => host.actorThread(thread)),
  awaitActorHead: (mark) => Effect.promise((signal) => host.awaitActorHead(mark, signal)),
  list: Effect.promise(async () => Promise.all((await host.threads()).map(async (id) => ({ id, events: await host.read(id) })))),
  settled: Effect.promise(() => host.settled())
})

// bunHttpServices adapts a hydrated Bun host for HTTP serving (create-host.test.ts).
export const bunHttpServices = (host: object) => {
  const backend = hostBackend(host)
  const statusOf: ActorThreads["statusOf"] = (events) => backend.resting(events) ? "settled" : "running"
  const storage = { kind: "sqlite", location: backend.storage }
  const threadsFor = (instance: string, runtime: BunHost) => bunHttpThreads(runtime, {
    actor: backend.actor, instance, methods: backend.methods, storage, statusOf, allocate: backend.allocate
  })
  const ensure = (id: string) => Effect.promise(async () => threadsFor(id, await backend.ensure(id)))
  return Context.make(Threads, {
    methods: backend.methods,
    storage,
    actorName: backend.actor,
    definitions: Effect.succeed([{ name: backend.actor, builtIn: false }]),
    instances: Effect.sync(() => [...backend.instances.keys()].sort().map((id) => ({ id, definition: backend.actor }))),
    ensure,
    instance: (id) => Effect.sync(() => { const runtime = backend.instances.get(id); return runtime === undefined ? undefined : threadsFor(id, runtime) }),
    append: (instance, thread, event) => Effect.flatMap(ensure(instance), (threads) => threads.append(thread, event)),
    events: (instance, thread) => Effect.flatMap(ensure(instance), (threads) => threads.events(thread)),
    list: (instance) => Effect.flatMap(ensure(instance), (threads) => threads.list),
    settled: (instance) => Effect.flatMap(ensure(instance), (threads) => threads.settled)
  }).pipe(Context.add(DriverGauge, {
    resting: Effect.promise(async () => (await Promise.all([...backend.instances.values()].map((runtime) => runtime.resting()))).every(Boolean)),
    dirty: Effect.sync(() => [...backend.instances.values()].reduce((total, runtime) => total + runtime.work(), 0))
  }), Context.add(Ingress, ingressFrom({ resolve: backend.resolve })))
}
