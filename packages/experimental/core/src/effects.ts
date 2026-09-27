import { Context, Effect, Schema } from "effect"
import type { EffectRef } from "./internal/effects"
import type { Getter } from "./atom"

export const Deadline = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8_640_000_000_000_000))
export const ClockHandle = Schema.Struct({ executor: Schema.Literal("clock"), id: Schema.NonEmptyString, at: Deadline, value: Schema.optionalKey(Schema.Json) })
export type ClockHandle = typeof ClockHandle.Type
export const ExecutionHandle = Schema.Struct({ executor: Schema.NonEmptyString, id: Schema.NonEmptyString, endpoint: Schema.optionalKey(Schema.NonEmptyString), at: Schema.optionalKey(Deadline), value: Schema.optionalKey(Schema.Json) }).check(Schema.makeFilter(handle => handle.executor !== "clock" || handle.at !== undefined, { title: "Clock handles require a deadline" }))
export type ExecutionHandle = typeof ExecutionHandle.Type

export const FiberHandle = Schema.Struct({ executor: Schema.Literal("local"), id: Schema.NonEmptyString })
export type FiberHandle = typeof FiberHandle.Type

// EffectExecution supplies the current effect identity and forks work within the actor's lifetime.
export class EffectExecution extends Context.Service<EffectExecution, {
  readonly ref: EffectRef
  readonly get: Getter
  readonly record: <Event extends object>(event: Event) => Effect.Effect<void, Error>
  readonly fork: <Event extends object, Services>(work: Effect.Effect<Event | readonly Event[], Error, Services>) => Effect.Effect<FiberHandle, Error, Services>
}>()("experimental/EffectExecution") {}

// EffectValue settles with an event or an ordered, nonempty batch committed together by the host.
export interface EffectValue<Event, Error = never, Services = never> {
  readonly kind: "effect"
  readonly id: string
  readonly request?: Event
  readonly run: Effect.Effect<Event | readonly Event[], Error, Services>
}
export type EffectValues<Event, Error = never, Services = never> = Readonly<Record<string, EffectValue<Event, Error, Services>>>

// effectValue describes host-executed work without starting it.
export function effectValue<Request extends object, Result extends object, Error, Services>(value: {
  readonly id: string
  readonly request: Request
  readonly run: Effect.Effect<Result | readonly Result[], Error, Services>
}): EffectValue<Request | Result, Error, Services> {
  if (!value.id) throw new Error("Effect identity must not be empty")
  return { ...value, kind: "effect" }
}

// eventValue describes a local event delivery without a separate request event.
export function eventValue<Event extends object>(value: { readonly id: string; readonly event: Event }): EffectValue<Event> {
  if (!value.id) throw new Error("Effect identity must not be empty")
  return { kind: "effect", id: value.id, run: Effect.succeed(value.event) }
}
