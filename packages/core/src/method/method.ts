import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection, type Projection } from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ActorInvocation, ActorMethodCall } from "./call"
import type { InvocationCancellation } from "./cancellation"
import {
  eraseActorMethodProjection,
  type ActorMethodProjection,
  type ErasedActorMethodProjection
} from "./projection"
import type { ActorMethodState } from "./state"
import type { ActorMethodCancellationState, ActorMethodView } from "./view"

// ActorMethodCancellation declares how one method records a terminal cancellation.
export interface ActorMethodCancellation {
  readonly event: (cancellation: InvocationCancellation, at: number) => Event
}

export const ACTOR_METHOD_NAME_PATTERN = /^[a-z][A-Za-z0-9-]{0,62}$/u

export const DEFAULT_ACTOR_METHOD_TIMEOUT_MS = 300_000

export const actorMethodTimeoutOf = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_ACTOR_METHOD_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("actor method timeoutMs must be a positive safe integer")
  }
  return resolved
}

export interface InvalidDurableMethodInput {
  readonly event: Event
  readonly index: number
  readonly log: ReadonlyArray<Event>
  readonly error: string
}

// DurableMethodInput declares how a method recognizes and rejects an invocation already present in a log.
export interface DurableMethodInput {
  readonly schema: Schema.ConstraintDecoder<unknown>
  readonly matches: (event: Event) => boolean
  readonly keyOf: (input: InvalidDurableMethodInput) => string
  readonly reject: (input: InvalidDurableMethodInput, at: number) => Event
  readonly projection?: ErasedDurableInputProjection
}

export interface DurableInputProjection<State>
  extends Projection<State, ReadonlyArray<Transition<never>>> {}

export interface ErasedDurableInputProjection
  extends Projection<unknown, ReadonlyArray<Transition<never>>> {}

// durableInputProjection preserves a typed validation quotient behind the heterogeneous method contract.
export const durableInputProjection = <State>(
  projection: DurableInputProjection<State>
): ErasedDurableInputProjection => ({
  initial: projection.initial,
  step: (state, event) => projection.step(state as State, event),
  output: (state) => projection.output(state as State)
})

// ActorMethodDeclaration is the erased shape a heterogeneous method table preserves. eventOf validates unknown input before constructing the durable event.
export interface ActorMethodDeclaration {
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly output: Schema.ConstraintDecoder<unknown>
  readonly timeoutMs: number
  readonly durableInput?: DurableMethodInput
  readonly cancellation?: ActorMethodCancellation
  readonly projection: ErasedActorMethodProjection
  readonly currentEpoch: (events: ReadonlyArray<Event>, id: string) => number
  readonly eventOf: (call: ActorMethodCall<unknown>) => Event
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<unknown> | undefined
}

// ActorMethodDefinition is the typed author surface for a method projection.
export interface ActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  State = never
> {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs?: number
  readonly durableInput?: DurableMethodInput
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly projection: ActorMethodProjection<State, Output["Type"]>
  readonly cancellation?: ActorMethodCancellation
}

/** @deprecated Use ActorMethodDefinition. The primary definition now describes the projected method contract. */
export type IncrementalActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  State = never
> = ActorMethodDefinition<Input, Output, State>

// ActorMethod carries a typed definition and its dynamically callable event builder.
export type ActorMethod<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> = Omit<ActorMethodDeclaration, "input" | "output" | "state"> & {
  readonly input: Input
  readonly output: Output
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<Output["Type"]> | undefined
}

export type ActorMethods = Readonly<Record<string, ActorMethodDeclaration>>

// initialMethodStates constructs private projection state for every method.
export const initialMethodStates = (methods: ActorMethods): ReadonlyMap<string, unknown> =>
  new Map(Object.entries(methods).map(([name, method]) => [name, method.projection.initial()]))

// reduceMethodStates advances every method projection with one event.
export const reduceMethodStates = (
  methods: ActorMethods,
  states: ReadonlyMap<string, unknown>,
  event: Event
): ReadonlyMap<string, unknown> => new Map(Object.entries(methods).map(([name, method]) => [
  name,
  method.projection.step(states.get(name), event)
]))

export type ActorMethodInput<Method extends ActorMethodDeclaration> = Method["input"]["Type"]

export type ActorMethodOutput<Method extends ActorMethodDeclaration> = Method["output"]["Type"]

// cancellationStateOf reports cancellation progress from the method view.
export const cancellationStateOf = (
  method: ActorMethodDeclaration | undefined,
  view: ActorMethodView<unknown> | undefined,
  invocation: ActorInvocation
): ActorMethodCancellationState | undefined => {
  if (method?.cancellation === undefined || view === undefined) return undefined
  if (view.cancellationState !== undefined) return view.cancellationState(invocation)
  const state = view.invocationState(invocation)
  if (state === undefined) return undefined
  if (state.status === "pending") return "running"
  if (state.status === "cancelled") return "cancelled"
  return "terminal"
}

// actorMethod constructs a method from its typed projection.
export function actorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>,
  State = never
>(definition: ActorMethodDefinition<Input, Output, State> & {
  readonly cancellation: ActorMethodCancellation
}): ActorMethod<Input, Output> & { readonly cancellation: ActorMethodCancellation }
export function actorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>,
  State = never
>(definition: ActorMethodDefinition<Input, Output, State> & {
  readonly cancellation?: undefined
}): ActorMethod<Input, Output> & { readonly cancellation?: undefined }
export function actorMethod(
  definition: ActorMethodDefinition<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>, unknown>
): ActorMethod<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>> {
  const projection = eraseActorMethodProjection(definition.projection)
  const currentEpoch = (events: ReadonlyArray<Event>, id: string): number =>
    replayProjection(projection, events).currentEpoch(id)
  const state = (events: ReadonlyArray<Event>, invocation: ActorInvocation): ActorMethodState<unknown> | undefined =>
    replayProjection(projection, events).invocationState(invocation)
  return {
    input: definition.input,
    output: definition.output,
    timeoutMs: actorMethodTimeoutOf(definition.timeoutMs),
    ...(definition.durableInput === undefined ? {} : { durableInput: definition.durableInput }),
    ...(definition.cancellation === undefined ? {} : { cancellation: definition.cancellation }),
    projection,
    currentEpoch,
    event: definition.event,
    eventOf: (call) => definition.event({
      ...call,
      input: Schema.decodeUnknownSync(definition.input)(call.input)
    }),
    state
  }
}

// actorMethodsOf validates names and declarations at the actor boundary.
export const actorMethodsOf = <const Methods extends ActorMethods>(methods: Methods): Methods => {
  const names = new Map<ActorMethodDeclaration, string>()
  for (const [name, declaration] of Object.entries(methods)) {
    if (!ACTOR_METHOD_NAME_PATTERN.test(name)) {
      throw new Error(`actor method name must match ${String(ACTOR_METHOD_NAME_PATTERN)}, got ${JSON.stringify(name)}`)
    }
    if (typeof declaration !== "object" || declaration === null) {
      throw new Error(`actor method ${JSON.stringify(name)} must be a declaration`)
    }
    const candidate = declaration as Partial<ActorMethodDeclaration>
    if (!Schema.isSchema(candidate.input) || !Schema.isSchema(candidate.output)) {
      throw new Error(`actor method ${JSON.stringify(name)} must declare input and output schemas`)
    }
    actorMethodTimeoutOf(candidate.timeoutMs)
    if (typeof candidate.eventOf !== "function" || typeof candidate.state !== "function" ||
      typeof candidate.currentEpoch !== "function") {
      throw new Error(`actor method ${JSON.stringify(name)} must declare eventOf, state, and currentEpoch functions`)
    }
    if (candidate.projection === undefined || typeof candidate.projection.initial !== "function" ||
      typeof candidate.projection.step !== "function" || typeof candidate.projection.output !== "function") {
      throw new Error(`actor method ${JSON.stringify(name)} must declare a projection`)
    }
    if (candidate.cancellation !== undefined && (
      typeof candidate.cancellation !== "object" || candidate.cancellation === null ||
      typeof candidate.cancellation.event !== "function"
    )) {
      throw new Error(`actor method ${JSON.stringify(name)} cancellation must declare an event function`)
    }
    const previous = names.get(declaration)
    if (previous !== undefined) {
      throw new Error(`actor methods ${JSON.stringify(previous)} and ${JSON.stringify(name)} share one declaration`)
    }
    names.set(declaration, name)
  }
  return methods
}
