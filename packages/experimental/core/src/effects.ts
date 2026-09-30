import { type Effect, Schema } from "effect"
import type { EffectExecution } from "./services/effect-execution"
import type { ActRequest } from "./act"
import type { EffectRef } from "./effect-ref"
import type { EffectRequest } from "./lifecycle"
import { atom, type Atom, type Getter } from "./atom"

export { EffectExecution } from "./services/effect-execution"

export const Deadline = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8_640_000_000_000_000))
export const ClockHandle = Schema.Struct({ executor: Schema.Literal("clock"), id: Schema.NonEmptyString, at: Deadline, value: Schema.optionalKey(Schema.Json) })
export type ClockHandle = typeof ClockHandle.Type
export const ExecutionHandle = Schema.Struct({ executor: Schema.NonEmptyString, id: Schema.NonEmptyString, endpoint: Schema.optionalKey(Schema.NonEmptyString), mode: Schema.optionalKey(Schema.Literals(["poll", "push"])), at: Schema.optionalKey(Deadline), value: Schema.optionalKey(Schema.Json) }).check(Schema.makeFilter(handle => handle.executor !== "clock" || handle.at !== undefined, { title: "Clock handles require a deadline" }))
export type ExecutionHandle = typeof ExecutionHandle.Type

export const FiberHandle = Schema.Struct({ executor: Schema.Literal("local"), id: Schema.NonEmptyString })
export type FiberHandle = typeof FiberHandle.Type

// EventValue proposes a domain event for direct journal delivery.
export interface EventValue<Event> {
  readonly kind: "event"
  readonly event: Event
}

export interface ActorOutput<View, Event, Services = never> {
  readonly view: View
  readonly events: Readonly<Record<string, EventValue<Event>>>
  readonly acts: Readonly<Record<string, ActRequest<Schema.Json, Schema.Json, Services>>>
}

// effectAtom derives a view and typed proposals for the runtime.
export function effectAtom<const Value extends ActorOutput<unknown, unknown, unknown>>(read: (get: Getter) => Value): Atom<Value> {
  return atom(read)
}

// eventValue describes a domain event without external work; its producer must withdraw it after delivery.
export function eventValue<Event extends object>(event: Event): EventValue<Event> {
  return { kind: "event", event }
}

export interface EffectWork<Services = never> {
  readonly kind: "act"
  readonly id: string
  readonly request: EffectRequest
  readonly source: string
  readonly ref?: EffectRef
  readonly execute: Effect.Effect<import("./execution-result").ExecutionResult, Schema.Json, Services | EffectExecution>
}
export interface IdentifiedEffectValue<Services = never> extends EffectWork<Services> {
  readonly ref: EffectRef
}
type Proposal = EventValue<unknown> | ActRequest<Schema.Json, Schema.Json, unknown>
type CollectedProposals<Value> = Value extends { readonly events: infer Events; readonly acts: infer Acts } ? Events[keyof Events] | Acts[keyof Acts] : never
export type Proposed<Value> = Extract<NonNullable<CollectedProposals<Value>>, Proposal>
export type ServicesOf<P> = P extends ActRequest<Schema.Json, Schema.Json, infer Services> ? Services | EffectExecution : never
