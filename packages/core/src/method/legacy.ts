import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { ActorInvocation, ActorMethodCall } from "./call"
import {
  actorMethod,
  type ActorMethod,
  type ActorMethodCancellation,
  type DurableMethodInput
} from "./method"
import type { ActorMethodProjection } from "./projection"
import type { ActorMethodState } from "./state"
import type { ActorMethodCancellationState } from "./view"

/** @deprecated Use ActorMethodCancellation through actorMethod. This compatibility shape reads cancellation state from complete event history. */
export interface LegacyActorMethodCancellation extends ActorMethodCancellation {
  readonly state: (
    events: ReadonlyArray<Event>,
    invocation: ActorInvocation
  ) => ActorMethodCancellationState | undefined
}

/** @deprecated Use ActorMethodDefinition with actorMethod. This compatibility definition retains complete event history as projection state. */
export interface LegacyActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs?: number
  readonly durableInput?: DurableMethodInput
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly currentEpoch?: (events: ReadonlyArray<Event>, id: string) => number
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<Output["Type"]> | undefined
  readonly cancellation?: LegacyActorMethodCancellation
}

const legacyProjection = <Input extends Schema.ConstraintDecoder<unknown>, Output extends Schema.ConstraintDecoder<unknown>>(
  definition: LegacyActorMethodDefinition<Input, Output>
): ActorMethodProjection<ReadonlyArray<Event>, Output["Type"]> => ({
  initial: () => [],
  step: (events, event) => [...events, event],
  output: (events) => ({
    currentEpoch: (id) => definition.currentEpoch?.(events, id) ?? 0,
    invocationState: (invocation) => definition.state(events, invocation),
    ...(definition.cancellation === undefined
      ? {}
      : { cancellationState: (invocation: ActorInvocation) => definition.cancellation!.state(events, invocation) })
  })
})

/** @deprecated Use actorMethod with an ActorMethodProjection. This adapter retains complete event history as projection state. */
export function legacyActorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>
>(definition: LegacyActorMethodDefinition<Input, Output> & {
  readonly cancellation: LegacyActorMethodCancellation
}): ActorMethod<Input, Output> & { readonly cancellation: ActorMethodCancellation }
/** @deprecated Use actorMethod with an ActorMethodProjection. This adapter retains complete event history as projection state. */
export function legacyActorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>
>(definition: LegacyActorMethodDefinition<Input, Output> & {
  readonly cancellation?: undefined
}): ActorMethod<Input, Output> & { readonly cancellation?: undefined }
export function legacyActorMethod(
  definition: LegacyActorMethodDefinition<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>>
): ActorMethod<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>> {
  const common = {
    input: definition.input,
    output: definition.output,
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    ...(definition.durableInput === undefined ? {} : { durableInput: definition.durableInput }),
    event: definition.event,
    projection: legacyProjection(definition)
  }
  return definition.cancellation === undefined
    ? actorMethod(common)
    : actorMethod({ ...common, cancellation: { event: definition.cancellation.event } })
}
