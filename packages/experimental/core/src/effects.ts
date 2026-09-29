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

export type EffectValues<Event, Services = never> = Readonly<Record<string, EventValue<Event> | ActRequest<Schema.Json, Schema.Json, Services>>>

export interface EffectOutput<View, Event, Services = never> {
  readonly view: View
  readonly effects: EffectValues<Event, Services>
}

// effectAtom derives a view and typed proposals for the runtime.
export function effectAtom<const Value extends { readonly view: unknown; readonly effects: Readonly<Record<string, Proposal>> }>(read: (get: Getter) => Value): Atom<Value> {
  return atom(read)
}

// eventValue describes a domain event without external work; its producer must withdraw it after delivery.
export function eventValue<Event extends object>(event: Event): EventValue<Event> {
  return { kind: "event", event }
}

export interface IdentifiedEffectValue<Services = never> {
  readonly kind: "act"
  readonly id: string
  readonly request: EffectRequest
  readonly ref: EffectRef
  readonly execute: Effect.Effect<import("./execution-result").ExecutionResult, Schema.Json, Services | EffectExecution>
}
type Proposal = EventValue<unknown> | ActRequest<Schema.Json, Schema.Json, unknown>
type DirectEffectValue<Value> = Value extends { readonly effect?: infer P } ? Extract<NonNullable<P>, Proposal> : never
type CollectedProposals<Value> = Value extends { readonly effects: infer Collection } ? Collection[keyof Collection] : never
export type Proposed<Value> = Extract<Value, Proposal> | DirectEffectValue<Value> | Extract<NonNullable<CollectedProposals<Value>>, Proposal>
export type ServicesOf<P> = P extends ActRequest<Schema.Json, Schema.Json, infer Services> ? Services | EffectExecution : never
