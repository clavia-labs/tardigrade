/**
 * ActorAllocation exposes host-assigned root and child thread references (allocation.test.ts).
 *
 *   ActorAllocation (e.g., "tardie")
 *     ├── allocateRootThread
 *     │     ├── instance       actor instance, such as "rick"
 *     │     ├── name?          caller-selected thread name, e.g., "main"
 *     │     └── key?           unnamed allocation's retry identity
 *     └── allocateChildThread
 *           ├── parent         thread coordinate (tardie/rick/main)
 *           │     ├── actor    actor definition's name, e.g., "tardie"
 *           │     ├── instance parent's actor instance, e.g., "rick"
 *           │     └── thread   parent thread's name, e.g., "main"
 *           ├── name?          caller-selected child thread name, e.g., "lab"
 *           └── key?           unnamed allocation's retry identity
 *
 * A name excludes a separate key.
 * Unnamed allocations use an action-scoped key during replay or a fresh request key outside an action unless an explicit key is supplied (allocation.test.ts; ../runtime/reconciler.ts).
 */

import { Context, Effect, Option, Schema } from "effect"
import { childKeyOf, ChildKey, ThreadCoordinate, threadCoordinateOf, actorCoordinateOf } from "./coordinate"

import type { ActorDefinition } from "./definition"
import type { ActorMethods } from "./method"
import { bindThreadMethods, targetCoordinate, type ThreadTarget, type ThreadRef } from "./reference"
import { ChildPlacement, ThreadDepth } from "../interaction/relations"

export interface RootThreadOptions {
  readonly instance: string // instantiation of an actor definition
  readonly name?: string // thread name
  readonly key?: string // allocation key for idempotent thread creation
}

export interface ChildThreadOptions {
  readonly parent: ThreadCoordinate | ThreadTarget
  readonly name?: string // thread name
  readonly key?: string // allocation key for idempotent thread creation
}

export { ThreadAllocationScope } from "../runtime/context"
import { ThreadAllocationScope } from "../runtime/context"

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
  const coordinate = yield* allocateThread({
    kind: "root", coordinate: threadCoordinateOf(actorCoordinateOf(actor.name, options.instance), identity.name),
    ...(identity.key === undefined ? {} : { key: identity.key })
  })
  return bindThreadMethods({ coordinate, methods: actor.methods })
})

// allocateChildThread assigns a parent-scoped name within the parent's actor instance.
export const allocateChildThread = <Methods extends ActorMethods>(
  actor: Pick<ActorDefinition<Methods>, "name" | "methods">,
  options: ChildThreadOptions
): Effect.Effect<ThreadRef<Methods>, never, ThreadAllocator> => Effect.gen(function* () {
  const parent = "coordinate" in options.parent || "address" in options.parent ? targetCoordinate(options.parent) : options.parent
  if (parent.actor !== actor.name) {
    return yield* Effect.die(new Error("child allocation requires a parent from the same actor definition"))
  }
  const identity = yield* allocationIdentity(options)
  const coordinate = yield* allocateChildCoordinate({
    parent,
    child: childKeyOf(identity.name || "unnamed"),
    ...(identity.key === undefined ? {} : { key: identity.key })
  })
  return bindThreadMethods({ coordinate, methods: actor.methods }, parent)
})

// ChildThreadRequest identifies a logical spawn within its parent's namespace.
export const ChildThreadRequest = Schema.Struct({
  maxDepth: Schema.optionalKey(ThreadDepth),
  placement: Schema.optionalKey(ChildPlacement),
  key: Schema.optionalKey(Schema.NonEmptyString),
  parent: ThreadCoordinate,
  child: ChildKey
})
export type ChildThreadRequest = typeof ChildThreadRequest.Type

// ThreadAllocation carries identity and initial log inputs for host creation (packages/host/src/thread-supervisor.test.ts).
export const ThreadAllocation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("root"), coordinate: ThreadCoordinate,
    key: Schema.optionalKey(Schema.NonEmptyString),
    fork: Schema.optionalKey(Schema.Struct({ source: ThreadCoordinate, seq: ThreadDepth })) }),
  Schema.Struct({ kind: Schema.Literal("child"), ...ChildThreadRequest.fields })
])
export type ThreadAllocation = typeof ThreadAllocation.Type

// ThreadAllocator assigns roots and children within a shared actor-instance namespace.
// Implementations must preserve assignments across retries and restarts and separate distinct requests from each other and existing threads.
// Host conformance properties are in packages/host/src/allocation.test.ts.
export class ThreadAllocator extends Context.Service<ThreadAllocator, {
  readonly allocate: (request: ThreadAllocation) => Effect.Effect<ThreadCoordinate>
}>()("tardigrade/ThreadAllocator") {}

// allocateThread validates the host's assignment without prescribing its thread identity (allocation.test.ts).
export const allocateThread = (request: ThreadAllocation) => Effect.gen(function* () {
  const normalized = yield* Schema.decodeEffect(ThreadAllocation)(request).pipe(Effect.orDie)
  const parent = normalized.kind === "root" ? normalized.coordinate : normalized.parent
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
