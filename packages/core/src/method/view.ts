import type { ActorInvocation } from "./call"
import type { ActorMethodState } from "./state"

export type ActorMethodCancellationState = "running" | "cancelled" | "terminal"

/**
 * ActorMethodView exposes invocation lifecycle queries derived from one projected history.
 *
 *   ActorMethodView<Output>
 *                   │
 *                   └─ value returned by a completed invocation
 *
 *   ActorMethodView
 *     ├── currentEpoch(id)
 *     ├── invocationState(invocation)
 *     └── cancellationState?(invocation)
 */
export interface ActorMethodView<Output = unknown> {
  readonly currentEpoch: (id: string) => number
  readonly invocationState: (invocation: ActorInvocation) => ActorMethodState<Output> | undefined
  readonly cancellationState?: (invocation: ActorInvocation) => ActorMethodCancellationState | undefined
}
