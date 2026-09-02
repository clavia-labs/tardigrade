import type { ActorInvocation } from "@clavia/tardigrade-core/actor/method"
import type { Event } from "@clavia/tardigrade-core/event"

// Intent proposes events without external work. The actor supplies commit time, appends the result, and re-derives before more work (actor.properties.test.ts, "a committed intent invalidates every remaining transition from its snapshot"; tla/runtime/Coherence.tla, NoSuppressedCommit).
export interface Intent<Input = unknown> {
  readonly kind: "intent"
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly events: (input: Input, at: number) => ReadonlyArray<Event>
}

// intent constructs an event proposal and erases its input type for heterogeneous projections.
export const intent = <Input>(proposal: {
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly events: (input: Input, at: number) => ReadonlyArray<Event>
}): Intent<never> => ({ kind: "intent", ...proposal }) as unknown as Intent<never>
