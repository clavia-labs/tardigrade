import { Effect as EffectRuntime } from "effect"
import type { ActorInvocation } from "@clavia/tardigrade-core/method"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/log"

/**
 * ExternalEffect is one keyed unit of work outside the event log. Its action may use required services, append evidence, and return events (tla/runtime/Reconcile.tla, CommitOne).
 *
 *   ExternalEffect<Input, Requirements>
 *                  │          │
 *                  │          └─ services needed to perform the work
 *                  └──────────── data captured for the action
 *
 * An event commits the effect when the actor derives the same key for the event and the effect. The event's type and meaning do not change that rule. Use attempted for work that may retry before it records an operation outcome.
 *
 * The abort signal lets the runtime interrupt cancellable work. The interrupts predicate identifies which incoming events invalidate a running action.
 */
export interface ExternalEffect<Input = unknown, Requirements = never> {
  readonly kind: "effect"
  readonly key: string
  readonly concurrent?: boolean
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly interrupts?: (input: Input, event: Event) => boolean
  readonly act: (
    input: Input,
    signal: AbortSignal
  ) => EffectRuntime.Effect<ReadonlyArray<Event>, never, EventLog | Requirements>
}

/**
 * effect constructs typed external work and erases its input type for heterogeneous transition collections.
 *
 * Input and Requirements are inferred while the work is authored:
 *
 *   effect({
 *     input: MyInput,
 *     act: (input: MyInput, signal) => Effect<Event[], never, EventLog | MyServices>
 *   })
 *
 * ExternalEffect<never, Requirements> hides the private input type while preserving the required services. This lets differently typed effects share one collection without losing compile-time dependency checking.
 *
 *   ExternalEffect<InputA, ServiceA> ─┐
 *   ExternalEffect<InputB, ServiceB> ─┼─> ReadonlyArray<ExternalEffect<never, ServiceA | ServiceB>>
 *   ExternalEffect<InputC, ServiceC> ─┘
 *
 * The constructor keeps each input value paired with the action that consumes it. The runtime must pass the stored input back to that same action.
 */
export const effect = <Input, Requirements = never>(work: {
  readonly key: string
  readonly concurrent?: boolean
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly interrupts?: (input: Input, event: Event) => boolean
  readonly act: (
    input: Input,
    signal: AbortSignal
  ) => EffectRuntime.Effect<ReadonlyArray<Event>, never, EventLog | Requirements>
}): ExternalEffect<never, Requirements> => ({ kind: "effect", ...work }) as unknown as ExternalEffect<never, Requirements>
