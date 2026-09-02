import { Effect as EffectRuntime } from "effect"
import type { ActorInvocation } from "@clavia/tardigrade-core/actor/method"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog } from "@clavia/tardigrade-core/log"

// ExternalEffect is one keyed unit of outside-world work. Its key and input are projections of the event set (tla/runtime/Reconcile.tla, CommitOne). Its action may append evidence, and one appended or returned event must derive the key.
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

// effect constructs external work and erases its input type for heterogeneous projections.
export const effect = <Input, Requirements = never>(work: {
  readonly key: string
  readonly invocation?: ActorInvocation
  readonly input: Input
  readonly interrupts?: (input: Input, event: Event) => boolean
  readonly act: (
    input: Input,
    signal: AbortSignal
  ) => EffectRuntime.Effect<ReadonlyArray<Event>, never, EventLog | Requirements>
}): ExternalEffect<never, Requirements> => ({ kind: "effect", ...work }) as unknown as ExternalEffect<never, Requirements>
