import { Context, Effect, Option, Schema } from "effect"
import { childKeyOf, type ChildKey, ThreadCoordinate, threadCoordinateOf, actorCoordinateOf } from "./coordinate"

import type { ActorDefinition } from "./definition"
import type { ActorMethods } from "./method"
import { bindThreadMethods, type ThreadTarget, type ThreadRef } from "./reference"

export interface RootThreadOptions {
  readonly instance: string
  readonly name?: string
  readonly key?: string
}

export interface ChildThreadOptions {
  readonly parent: ThreadTarget
  readonly name?: string
  readonly key?: string
}

// ThreadAllocationScope identifies allocations within one replayed action.
export class ThreadAllocationScope extends Context.Service<ThreadAllocationScope, {
  readonly key: (explicit?: string) => string
}>()("tardigrade/ThreadAllocationScope") {}

const allocationIdentity = (options: { readonly name?: string; readonly key?: string }) => Effect.gen(function* () {
  if (options.name !== undefined) {
    if (options.key !== undefined) return yield* Effect.die(new Error("named allocations do not accept a separate key"))
    return { name: yield* Schema.decodeEffect(Schema.NonEmptyString)(options.name).pipe(Effect.orDie) }
  }
  const scope = yield* Effect.serviceOption(ThreadAllocationScope)
  const explicit = options.key === undefined ? undefined : yield* Schema.decodeEffect(Schema.NonEmptyString)(options.key).pipe(Effect.orDie)
  // Unscoped creation keys must remain independent of replay-seeded randomness.
  // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
  const key = Option.isSome(scope) ? scope.value.key(explicit) : explicit ?? crypto.randomUUID()
  return { name: "", key }
})

export interface ActorAllocation<Methods extends ActorMethods> {
  readonly allocateRootThread: (options: RootThreadOptions) => Effect.Effect<ThreadRef<Methods>, never, ThreadAllocator>
  readonly allocateChildThread: (options: ChildThreadOptions) => Effect.Effect<ThreadRef<Methods>, never, ThreadAllocator>
}

// allocateRootThread resolves an instance-scoped name through the host allocator.
export const allocateRootThread = <Methods extends ActorMethods>(
  actor: Pick<ActorDefinition<Methods>, "name" | "methods">,
  options: RootThreadOptions
): Effect.Effect<ThreadRef<Methods>, never, ThreadAllocator> => Effect.gen(function* () {
  const identity = yield* allocationIdentity(options)
  const address = yield* allocateThread({
    kind: "root", coordinate: threadCoordinateOf(actorCoordinateOf(actor.name, options.instance), identity.name),
    ...(identity.key === undefined ? {} : { key: identity.key })
  })
  return bindThreadMethods({ address, methods: actor.methods })
})

// allocateChildThread assigns a parent-scoped name within the parent's actor instance.
export const allocateChildThread = <Methods extends ActorMethods>(
  actor: Pick<ActorDefinition<Methods>, "name" | "methods">,
  options: ChildThreadOptions
): Effect.Effect<ThreadRef<Methods>, never, ThreadAllocator> => Effect.gen(function* () {
  if (options.parent.address.actor !== actor.name) {
    return yield* Effect.die(new Error("child allocation requires a parent from the same actor definition"))
  }
  const identity = yield* allocationIdentity(options)
  const address = yield* allocateChildCoordinate({
    parent: options.parent.address,
    child: childKeyOf(identity.name || "unnamed"),
    ...(identity.key === undefined ? {} : { key: identity.key })
  })
  return bindThreadMethods({ address, methods: actor.methods }, options.parent.address)
})

// ChildThreadRequest identifies a logical spawn within its parent's namespace.
export interface ChildThreadRequest {
  readonly key?: string
  readonly parent: ThreadCoordinate
  readonly child: ChildKey
}

// ThreadAllocation identifies a root name or a parent-scoped child name for host assignment.
export type ThreadAllocation =
  | { readonly kind: "root"; readonly coordinate: ThreadCoordinate; readonly key?: string }
  | ({ readonly kind: "child" } & ChildThreadRequest)

// ThreadAllocator assigns roots and children within a shared actor-instance namespace.
// Implementations must preserve assignments across retries and restarts and separate distinct requests from each other and existing threads.
// Host conformance properties are in packages/host/src/allocation.test.ts.
export class ThreadAllocator extends Context.Service<ThreadAllocator, {
  readonly allocate: (request: ThreadAllocation) => Effect.Effect<ThreadCoordinate>
}>()("tardigrade/ThreadAllocator") {}

// allocateThread validates the host's assignment without prescribing its thread identity (allocation.test.ts).
export const allocateThread = (request: ThreadAllocation) => Effect.gen(function* () {
  const parent = yield* Schema.decodeEffect(ThreadCoordinate)(request.kind === "root" ? request.coordinate : request.parent).pipe(Effect.orDie)
  const key = request.key === undefined ? {} : { key: yield* Schema.decodeEffect(Schema.NonEmptyString)(request.key).pipe(Effect.orDie) }
  const normalized: ThreadAllocation = request.kind === "root" ? { kind: "root", coordinate: parent, ...key }
    : { kind: "child", parent, child: childKeyOf(request.child), ...key }
  const allocator = yield* ThreadAllocator
  const target = yield* allocator.allocate(normalized).pipe(
    Effect.flatMap(Schema.decodeEffect(ThreadCoordinate)), Effect.orDie
  )
  if (target.actor !== parent.actor || target.instance !== parent.instance ||
    (request.kind === "child" && target.thread === parent.thread)) {
    return yield* Effect.die(new Error(request.kind === "root"
      ? "root allocation must preserve its actor instance"
      : "child allocation must name another thread in the parent's actor instance"))
  }
  return target
})

// allocateChildCoordinate requests a child assignment from the host.
export const allocateChildCoordinate = (request: ChildThreadRequest) => allocateThread({ kind: "child", ...request })

// reserveRootThread reserves a caller-selected coordinate with the host.
export const reserveRootThread = (coordinate: ThreadCoordinate) => allocateThread({ kind: "root", coordinate }).pipe(
  Effect.flatMap((target) => target.thread === coordinate.thread ? Effect.succeed(target)
    : Effect.die(new Error("root reservation must preserve its requested coordinate")))
)
