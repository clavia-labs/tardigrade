import type { InvocationRef } from "../interaction/invocation"
import type { TransitionRef } from "../transition/transition"
import { Context } from "effect"
import type { ThreadAddress } from "../transport/endpoint"
import type { ActorInvocationContext } from "../interaction/invocation"

// Self is the current actor's own address, bound by the platform per thread.
export class Self extends Context.Service<Self, ThreadAddress>()("tardigrade/Self") {}

// InvocationScope supplies the accepted caller context and interruption signal for replayable work.
export class InvocationScope extends Context.Service<InvocationScope, {
  readonly context: ActorInvocationContext
  readonly signal: AbortSignal
}>()("tardigrade/InvocationScope") {}

// InvocationSuspended marks a pending call for the reconciler.
export class InvocationSuspended extends Error {}

// ThreadAllocationScope identifies allocations within one replayed action.
export class ThreadAllocationScope extends Context.Service<ThreadAllocationScope, {
  readonly key: (explicit?: string) => string
}>()("tardigrade/ThreadAllocationScope") {}


// OwnerRef identifies the invocation or transition that owns nested work (tla/runtime/OperationOwnership.tla, OwnershipComplete).
export type OwnerRef =
  | { readonly type: "invocation"; readonly ref: InvocationRef }
  | { readonly type: "transition"; readonly ref: TransitionRef }

// OperationScope supplies runtime-owned identity to nested dispatch (tla/runtime/OperationOwnership.tla, ExactResolution).
export class OperationScope extends Context.Service<OperationScope, OwnerRef>()("tardigrade/OperationScope") {}

// ownerKey scopes nested operation names to their runtime owner (interaction/execution.test.ts).
export const ownerKey = (owner: OwnerRef): string => owner.type === "invocation"
  ? JSON.stringify([owner.type, owner.ref.method, owner.ref.id, owner.ref.epoch])
  : JSON.stringify([owner.type, owner.ref.seq, owner.ref.component, owner.ref.tag])
