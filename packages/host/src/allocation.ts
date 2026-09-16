import { sameThreadAddress, threadCreatedOf, childLineageFor, type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor/events"
import type { threadSupervisorDriver } from "./thread-supervisor"
import { ForkRefused, forkBatchFor } from "./fork"
import { Clock, Effect, Schema } from "effect"
import { ThreadCoordinate, threadIdOf } from "@clavia/tardigrade-core/actor/coordinate"
import { ThreadAllocator, ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { actorEventsOf, type ThreadRequested } from "@clavia/tardigrade-core/actor/events"
import { upcastThreadRequest } from "@clavia/tardigrade-core/actor/log/upcast"
import type { Event } from "@clavia/tardigrade-core/event"
import type { ActorMethodDeclaration } from "@clavia/tardigrade-core/actor/method"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction/prepare"
import { threadAllocationKey } from "@clavia/tardigrade-core/actor/supervisor"
export { threadAllocationKey, threadRequestOf } from "@clavia/tardigrade-core/actor/supervisor"

// instanceThreadAllocator rejects assignments outside the owning actor instance.
export const instanceThreadAllocator = (
  owner: { readonly actor: string; readonly instance: string },
  allocator: typeof ThreadAllocator.Service
): typeof ThreadAllocator.Service => ({
  allocate: (request) => {
    const target = request.kind === "root" ? request.coordinate : request.parent
    return target.actor === owner.actor && target.instance === owner.instance
      ? allocator.allocate(request)
      : Effect.die(new Error("thread assignment requires the owning actor directory"))
  }
})

export const DEFAULT_THREAD_ADJECTIVES = ["quiet", "bright", "swift", "calm", "bold", "gentle", "keen", "warm"] as const
export const DEFAULT_THREAD_NOUNS = ["fox", "owl", "otter", "wren", "lynx", "hare", "finch", "seal"] as const
export const DEFAULT_THREAD_TOKEN_LENGTH = 4
export const DEFAULT_THREAD_ALLOCATION_ATTEMPTS = 32

export interface ThreadAllocationPolicy {
  readonly adjectives?: ReadonlyArray<string>
  readonly nouns?: ReadonlyArray<string>
  readonly tokenLength?: number
  readonly maxAttempts?: number
  readonly generate?: () => string
}

// threadSlug generates a display-friendly candidate; the actor directory enforces uniqueness.
export const threadSlug = (policy: ThreadAllocationPolicy = {}): string => {
  const adjectives = policy.adjectives ?? DEFAULT_THREAD_ADJECTIVES
  const nouns = policy.nouns ?? DEFAULT_THREAD_NOUNS
  const length = policy.tokenLength ?? DEFAULT_THREAD_TOKEN_LENGTH
  if (adjectives.length === 0 || nouns.length === 0 || !Number.isSafeInteger(length) || length < 1) {
    throw new Error("thread slug needs word lists and a positive token length")
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length + 2))
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  const token = Array.from(bytes.slice(2), (byte) => alphabet[byte % alphabet.length]).join("")
  return `${adjectives[bytes[0]! % adjectives.length]}-${nouns[bytes[1]! % nouns.length]}-${token}`
}

export interface ThreadAllocationStore {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  // claim atomically returns the existing assignment, reserves the candidate, or reports a collision.
  readonly claim: (key: string, target: ThreadCoordinate, existingRoot: boolean, request: ThreadAllocation) => Effect.Effect<string | undefined>
}

// threadAllocationRecord keeps allocation identity in the actor's thread record (allocation.test.ts).
export const threadAllocationRecord = (
  events: ReadonlyArray<Event>, request: ThreadAllocation, target: ThreadCoordinate, existingRoot: boolean, at: number,
  method?: ActorMethodDeclaration
): { readonly thread: string; readonly event?: ThreadRequested } | undefined => {
  const key = threadAllocationKey(request)
  const records = actorEventsOf(events).filter((event) => event.type === "ThreadRequested")
  const assigned = records.find((record) => record.allocationKey === key)
  if (assigned !== undefined) return { thread: assigned.thread }
  const current = records.findLast((record) => record.thread === target.thread)
  if (current !== undefined && (current.allocationKey !== undefined || !existingRoot || upcastThreadRequest(current).parentThread !== undefined)) return undefined
  if (current !== undefined) return { thread: current.thread }
  const event: ThreadRequested = {
    type: "ThreadRequested", thread: target.thread, allocationKey: key, allocationRequest: request,
    at
  }
  return { thread: target.thread, event: method === undefined ? event : { ...prepareInvocation({
    reference: { target, invocation: { method: "requestThread", id: target.thread, epoch: 0 } },
    method, input: { target, request }, at
  }).event, ...event } }
}

// registeredThreadAllocator persists scoped assignments before returning them (allocation.test.ts; tla/Identity.tla, ThreadSeparation and RetryStable).
export const registeredThreadAllocator = (
  store: ThreadAllocationStore,
  policy: ThreadAllocationPolicy = {}
): typeof ThreadAllocator.Service => ({
  allocate: (request) => Effect.gen(function* () {
    const parent = yield* Schema.decodeEffect(ThreadCoordinate)(request.kind === "root" ? request.coordinate : request.parent).pipe(Effect.orDie)
    const key = threadAllocationKey(request)
    const recorded = yield* store.get(key)
    if (recorded !== undefined) return { ...parent, thread: recorded }
    if (request.key === undefined) {
      const name = threadIdOf(request.kind === "root" ? parent.thread : request.child)
      const thread = request.kind === "child" && name === parent.thread ? undefined
        : yield* store.claim(key, { ...parent, thread: name }, request.kind === "root", request)
      if (thread !== undefined) return { ...parent, thread }
      return yield* Effect.die(new Error(`thread name ${JSON.stringify(name)} is already taken in actor instance ${JSON.stringify([parent.actor, parent.instance])}`))
    }
    const attempts = policy.maxAttempts ?? DEFAULT_THREAD_ALLOCATION_ATTEMPTS
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("allocation attempts must be a positive integer")
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = threadIdOf((policy.generate ?? (() => threadSlug(policy)))())
      if (request.kind === "child" && candidate === parent.thread) continue
      const thread = yield* store.claim(key, { ...parent, thread: candidate }, false, request)
      if (thread !== undefined) return { ...parent, thread }
    }
    return yield* Effect.die(new Error(`thread allocation exhausted ${attempts} collision attempts`))
  })
})

// memoryThreadDirectory retains actor thread records for the lifetime of an in-memory host.
export const memoryThreadDirectory = (
  occupied: (target: ThreadCoordinate, existingRoot: boolean, request: ThreadAllocation) => boolean = () => false,
  method?: ActorMethodDeclaration,
  directories = new Map<string, Event[]>()
): ThreadAllocationStore => {
  return {
    get: (key) => Effect.sync(() => [...directories.values()].flatMap(actorEventsOf).find((event) => event.type === "ThreadRequested" && event.allocationKey === key)?.thread),
    claim: (_key, target, existingRoot, request) => Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => {
      const scope = JSON.stringify([target.actor, target.instance])
      const events = directories.get(scope) ?? []
      const record = threadAllocationRecord(events, request, target, existingRoot, at, method)
      if (record?.event === undefined) return record?.thread
      if (occupied(target, existingRoot, request)) return undefined
      events.push(record.event)
      directories.set(scope, events)
      return record.thread
    }))
  }
}

// hostThreadAllocator routes allocation and implicit creation through reservation before supervisor execution (thread-supervisor.test.ts).
export const hostThreadAllocator = (options: {
  readonly reserve: (request: ThreadAllocation) => Promise<ThreadCoordinate>
  readonly record: (target: ThreadCoordinate) => Promise<ActorThreadRecord | undefined>
  readonly owns: (target: ThreadCoordinate) => boolean
  readonly read: (target: ThreadCoordinate) => Promise<ReadonlyArray<Event>>
  readonly placement?: ChildPlacement
  readonly supervisor: ReturnType<typeof threadSupervisorDriver>
}) => {
  const finish = async (target: ThreadCoordinate, request: ThreadAllocation): Promise<ThreadCoordinate> => {
    if (!options.owns(target)) return target
    const record = await options.record(target)
    if (record === undefined) throw new Error("thread creation requires an allocation reservation")
    if (request.kind === "child") {
      const original = record.allocationRequest
      if (original?.kind === "root" || (original?.kind === "child" &&
        (!sameThreadAddress(original.parent, request.parent) ||
          (request.maxDepth !== undefined && request.maxDepth !== original.maxDepth) ||
          (request.placement !== undefined && request.placement !== original.placement)))) {
        throw new Error("a child thread already has different lineage")
      }
    }
    if (request.kind === "root" && request.fork !== undefined) {
      const original = record.allocationRequest
      if (original?.kind !== "root" || original.fork === undefined ||
        original.fork.seq !== request.fork.seq || !sameThreadAddress(original.fork.source, request.fork.source)) {
        throw new ForkRefused("occupied", `thread ${JSON.stringify(target.thread)} already has a log that is not this fork`)
      }
    }
    if (record.state === "registered") return target
    return options.supervisor.ensureReady(target)
  }
  const ready = async (target: ThreadCoordinate): Promise<void> => {
    if ((await options.record(target))?.state === "requested") await options.supervisor.ensureReady(target)
  }
  const complete = async (request: ThreadAllocation): Promise<ThreadAllocation> => {
    if (request.kind === "root") {
      if (request.fork !== undefined) {
        if (request.fork.source.actor !== request.coordinate.actor || request.fork.source.instance !== request.coordinate.instance) {
          throw new Error("a fork must preserve its actor instance")
        }
        await ready(request.fork.source)
        forkBatchFor(await options.read(request.fork.source), { ...request.fork, dest: request.coordinate.thread }, 0)
      }
      return request
    }
    await ready(request.parent)
    const parent = threadCreatedOf(await options.read(request.parent))
    if (parent === undefined) throw new Error("a child thread requires a created parent")
    const placement = request.placement ?? options.placement
    const { maxDepth } = childLineageFor(parent, { ...request, ...(placement === undefined ? {} : { placement }) })
    return { ...request, ...(maxDepth === undefined ? {} : { maxDepth }), ...(placement === undefined ? {} : { placement }) }
  }
  return {
    allocate: (request: ThreadAllocation): Effect.Effect<ThreadCoordinate> => Effect.flatMap(Schema.decodeEffect(ThreadAllocation)(request).pipe(Effect.orDie), (request) => Effect.promise(async () => {
      const scope = request.kind === "root" ? request.coordinate : request.parent
      const input = options.owns(scope) ? await complete(request) : request
      return finish(await options.reserve(input), input)
    })),
    ensure: (target: ThreadCoordinate, request: ThreadAllocation): Effect.Effect<ThreadCoordinate> => Effect.flatMap(Schema.decodeEffect(ThreadAllocation)(request).pipe(Effect.orDie), (request) => Effect.promise(async () => {
      if (!options.owns(target)) throw new Error("thread creation requires the owning allocator")
      if (await options.record(target) === undefined) {
        const assigned = await options.reserve(await complete(request))
        if (!sameThreadAddress(assigned, target)) throw new Error("thread reservation must preserve the delivery target")
      }
      return finish(target, request)
    }))
  }
}
