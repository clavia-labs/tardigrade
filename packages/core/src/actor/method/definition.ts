import { Schema } from "effect"
import type { Event } from "../../log/event"
import type { ActorInvocation, ActorMethodCall } from "./call"
import type { ActorMethodState } from "./state"
import type { InvocationCancellation } from "./cancellation"

export type ActorMethodCancellationState = "running" | "cancelled" | "terminal"

// ActorMethodCancellation declares how one method recognizes and terminates cancellable invocations.
export interface ActorMethodCancellation {
  readonly state: (
    events: ReadonlyArray<Event>,
    invocation: ActorInvocation
  ) => ActorMethodCancellationState | undefined
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
}

// ActorMethodDeclaration is the erased shape a heterogeneous method table preserves. eventOf validates unknown input before constructing the durable event.
export interface ActorMethodDeclaration {
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly output: Schema.ConstraintDecoder<unknown>
  readonly timeoutMs: number
  readonly durableInput?: DurableMethodInput
  readonly cancellation?: ActorMethodCancellation
  readonly currentEpoch: (events: ReadonlyArray<Event>, id: string) => number
  readonly eventOf: (call: ActorMethodCall<unknown>) => Event
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<unknown> | undefined
}

// ActorMethodDefinition declares one typed call as an input event and a result projection.
export interface ActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs?: number
  readonly durableInput?: DurableMethodInput
  readonly cancellation?: ActorMethodCancellation
  readonly currentEpoch?: (events: ReadonlyArray<Event>, id: string) => number
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<Output["Type"]> | undefined
}

// ActorMethod carries a typed definition and its dynamically callable event builder.
export type ActorMethod<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> = Omit<ActorMethodDefinition<Input, Output>, "timeoutMs" | "currentEpoch"> & ActorMethodDeclaration & {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs: number
  readonly currentEpoch: (events: ReadonlyArray<Event>, id: string) => number
  readonly state: (events: ReadonlyArray<Event>, invocation: ActorInvocation) => ActorMethodState<Output["Type"]> | undefined
}

export type ActorMethods = Readonly<Record<string, ActorMethodDeclaration>>

export type ActorMethodInput<Method extends ActorMethodDeclaration> = Method["input"]["Type"]

export type ActorMethodOutput<Method extends ActorMethodDeclaration> = Method["output"]["Type"]

// actorMethod preserves schema types and adds the validated event builder used after dynamic lookup.
export function actorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>
>(definition: ActorMethodDefinition<Input, Output> & {
  readonly cancellation: ActorMethodCancellation
}): ActorMethod<Input, Output> & { readonly cancellation: ActorMethodCancellation }
export function actorMethod<
  Input extends Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown>
>(definition: ActorMethodDefinition<Input, Output> & {
  readonly cancellation?: undefined
}): ActorMethod<Input, Output> & { readonly cancellation?: undefined }
export function actorMethod(
  definition: ActorMethodDefinition
): ActorMethod {
  return ({
  ...definition,
  timeoutMs: actorMethodTimeoutOf(definition.timeoutMs),
  currentEpoch: definition.currentEpoch ?? (() => 0),
  eventOf: (call) => definition.event({
    ...call,
    input: Schema.decodeUnknownSync(definition.input)(call.input)
  })
  }) as ActorMethod
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
    if (candidate.cancellation !== undefined && (
      typeof candidate.cancellation !== "object" || candidate.cancellation === null ||
      typeof candidate.cancellation.state !== "function" || typeof candidate.cancellation.event !== "function"
    )) {
      throw new Error(`actor method ${JSON.stringify(name)} cancellation must declare state and event functions`)
    }
    const previous = names.get(declaration)
    if (previous !== undefined) {
      throw new Error(`actor methods ${JSON.stringify(previous)} and ${JSON.stringify(name)} share one declaration`)
    }
    names.set(declaration, name)
  }
  return methods
}
