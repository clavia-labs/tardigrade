import { Clock, Effect, Schema } from "effect"
import { ThreadCoordinate, threadIdOf } from "@clavia/tardigrade-core/actor/coordinate"
import { allocateThread, ThreadAllocator, type ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { actorThreadsOf, type ThreadAllocated } from "@clavia/tardigrade-core/actor/events"
import type { Event } from "@clavia/tardigrade-core/event"

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

// initializingThreadAllocator makes root allocation await host initialization (e2e/actor/developer-flow.test.ts).
export const initializingThreadAllocator = (
  allocator: typeof ThreadAllocator.Service,
  initialize: (target: ThreadCoordinate, at: number) => Promise<void>
): typeof ThreadAllocator.Service => ({
  allocate: (request) => Effect.gen(function* () {
    const target = yield* allocateThread(request).pipe(Effect.provideService(ThreadAllocator, allocator))
    if (request.kind === "root") {
      const at = yield* Clock.currentTimeMillis
      yield* Effect.promise(() => initialize(target, at))
    }
    return target
  })
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
  events: ReadonlyArray<Event>, request: ThreadAllocation, target: ThreadCoordinate, existingRoot: boolean, at: number
): { readonly thread: string; readonly event?: ThreadAllocated } | undefined => {
  const key = threadAllocationKey(request)
  const records = actorThreadsOf(events)
  const assigned = records.find((record) => record.allocationKey === key)
  if (assigned !== undefined) return { thread: assigned.thread }
  const current = records.find((record) => record.thread === target.thread)
  if (current !== undefined && (current.allocationKey !== undefined || !existingRoot || current.parentThread !== undefined)) return undefined
  const parent = request.kind === "child" ? request.parent.thread : undefined
  return { thread: target.thread, event: {
    type: "ThreadAllocated", thread: target.thread, allocationKey: key,
    ...(parent === undefined ? {} : { parentThread: parent }),
    depth: parent === undefined ? 0 : (records.find((record) => record.thread === parent)?.depth ?? 0) + 1,
    at
  } }
}

export const threadAllocationKey = (request: ThreadAllocation): string => {
  const target = request.kind === "root" ? request.coordinate : request.parent
  return JSON.stringify([
    request.kind, target.actor, target.instance,
    ...(request.kind === "child" ? [target.thread] : []),
    request.key === undefined ? ["name", request.kind === "root" ? target.thread : request.child] : ["key", request.key]
  ])
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
    const attempts = policy.maxAttempts ?? DEFAULT_THREAD_ALLOCATION_ATTEMPTS
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("allocation attempts must be a positive integer")
    const namedRoot = request.kind === "root" && request.key === undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = threadIdOf(namedRoot && attempt === 0 ? parent.thread : (policy.generate ?? (() => threadSlug(policy)))())
      if (request.kind === "child" && candidate === parent.thread) continue
      const thread = yield* store.claim(key, { ...parent, thread: candidate }, namedRoot && candidate === parent.thread, request)
      if (thread !== undefined) return { ...parent, thread }
    }
    return yield* Effect.die(new Error(`thread allocation exhausted ${attempts} collision attempts`))
  })
})

// memoryThreadDirectory retains actor thread records for the lifetime of an in-memory host.
export const memoryThreadDirectory = (
  occupied: (target: ThreadCoordinate, existingRoot: boolean) => boolean = () => false
): ThreadAllocationStore => {
  const directories = new Map<string, Event[]>()
  return {
    get: (key) => Effect.sync(() => [...directories.values()].flatMap(actorThreadsOf).find((record) => record.allocationKey === key)?.thread),
    claim: (_key, target, existingRoot, request) => Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.sync(() => {
      const scope = JSON.stringify([target.actor, target.instance])
      const events = directories.get(scope) ?? []
      const record = threadAllocationRecord(events, request, target, existingRoot, at)
      if (record?.event === undefined) return record?.thread
      if (occupied(target, existingRoot)) return undefined
      events.push(record.event)
      directories.set(scope, events)
      return record.thread
    }))
  }
}
