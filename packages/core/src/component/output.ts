import type { Transition } from "@clavia/tardigrade-core/transition"
import type { InvocationCancellation } from "../interaction/events"
import type { Intent } from "../intent"

export { withResponse } from "../transition/transition"

// ComponentWork carries the response interaction offered by its owning child (composition/settlement.test.ts).
export type ComponentWork<Requirements = never, Result = never> = Transition<never, Requirements> & {
  readonly respond?: (result: Result) => Intent<never>
}

// CancellationInteraction proposes cleanup for an invocation from the current snapshot.
export interface CancellationInteraction<Requirements = never> {
  readonly cancel?: (cancellation: InvocationCancellation) => ReadonlyArray<Transition<never, Requirements>>
}

// ComponentOutput exposes a snapshot's public data, proposed work, and interactions.
export interface ComponentOutput<View, Requirements = never, Result = never, Interactions = unknown> {
  readonly interactions?: Interactions & CancellationInteraction<Requirements>
  readonly view: View
  readonly transitions: ReadonlyArray<ComponentWork<Requirements, Result>>
}
