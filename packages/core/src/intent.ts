import type { ActorInvocation } from "@clavia/tardigrade-core/method"
import type { Event } from "@clavia/tardigrade-core/event"

// Intent is simplest kind of work a projection can produce.
// The actor supplies commit time, appends the result, and re-derives before more work.
// Tests: actor.properties.test.ts, "a committed intent invalidates every remaining transition from its snapshot"; tla/runtime/Coherence.tla, NoSuppressedCommit.
export interface Intent<Input = unknown> {
  readonly kind: "intent"
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly events: (input: Input, at: number) => ReadonlyArray<Event>
}

/**
 * intent constructs a typed event proposal and erases its input type for heterogeneous transition collections.
 *
 * Input is inferred while the proposal is authored, so events receives the same type as input:
 *
 *   intent({
 *     input: MyInput,
 *     events: (input: MyInput, at) => Event[]
 *   })
 *
 * Different intents carry different input types. Intent<never> hides that private type so they can share one collection:
 *
 *   Intent<InputA> ─┐
 *   Intent<InputB> ─┼─> ReadonlyArray<Intent<never>>
 *   Intent<InputC> ─┘
 *
 * The constructor keeps each input value paired with the events function that consumes it. The runtime must pass the stored input back to that same function.
 */
export const intent = <Input>(proposal: {
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly events: (input: Input, at: number) => ReadonlyArray<Event>
}): Intent<never> => ({ kind: "intent", ...proposal }) as unknown as Intent<never>
