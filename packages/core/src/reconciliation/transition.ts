import { Effect } from "effect"
import type { ActorInvocation } from "../actor/method"
import type { Event } from "../log/event"
import { EventLog } from "../log"

// Intent proposes events without external work. The actor supplies commit time, appends the result,
// and re-derives before more work (actor.properties.test.ts, "a committed intent invalidates every
// remaining transition from its snapshot"; tla/runtime/Coherence.tla, NoSuppressedCommit).
export interface Intent<T = unknown> {
  readonly kind: "intent"
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: T
  readonly events: (input: T, at: number) => ReadonlyArray<Event>
}

// ExternalEffect is one keyed unit of outside-world work. Its key and input are projections of the
// event set (tla/runtime/Reconcile.tla, CommitOne). Its action may append evidence, and one appended
// or returned event must derive the key.
export interface ExternalEffect<T = unknown, R = never> {
  readonly kind: "effect"
  readonly key: string
  readonly concurrent?: boolean
  readonly invocation?: ActorInvocation
  readonly input: T
  readonly interrupts?: (input: T, event: Event) => boolean
  readonly act: (input: T, signal: AbortSignal) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}

// Transition is an intent or external effect offered from one log snapshot.
export type Transition<T = unknown, R = never> = Intent<T> | ExternalEffect<T, R>

// intent constructs an event proposal and erases its input type for heterogeneous reactors.
export const intent = <T>(proposal: {
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: T
  readonly events: (input: T, at: number) => ReadonlyArray<Event>
}): Intent<never> => ({ kind: "intent", ...proposal }) as unknown as Intent<never>

// effect constructs external work and erases its input type. The runtime calls act with the
// input from the same derivation.
export const effect = <T, R = never>(work: {
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: T
  readonly interrupts?: (input: T, event: Event) => boolean
  readonly act: (input: T, signal: AbortSignal) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}): ExternalEffect<never, R> => ({ kind: "effect", ...work }) as unknown as ExternalEffect<never, R>
