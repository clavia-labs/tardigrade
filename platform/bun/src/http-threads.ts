import { Clock, Effect } from "effect"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { childKeyOf, type ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { withLegacyThreadIds } from "@clavia/tardigrade-http/thread-compat"
import type { ActorThreads } from "@clavia/tardigrade-http/threads"
import type { BunHost } from "./host"

// bunHttpThreads adapts a Bun instance to the HTTP services (create-host.test.ts, apps/cli/src/init-flow.test.ts).
export const bunHttpThreads = (host: BunHost, options: {
  readonly actor: string
  readonly instance: string
  readonly methods: ActorMethods
  readonly sqlite: string
  readonly allocate: (request: ThreadAllocation) => Promise<ThreadCoordinate>
}): ActorThreads => withLegacyThreadIds({
  methods: options.methods,
  sqlite: options.sqlite,
  allocateRoot: (name, request = {}) => Effect.promise(async () => {
    if (name !== undefined && request.key !== undefined) throw new Error("named allocations do not accept a separate key")
    // HTTP request identities are minted outside actor replay.
    // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
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
