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

