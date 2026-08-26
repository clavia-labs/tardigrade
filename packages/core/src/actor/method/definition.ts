import { Schema } from "effect"
import type { Event } from "../../log/event"
import type { ActorMethodCall } from "./call"
import type { ActorMethodState } from "./state"

export const ACTOR_METHOD_NAME_PATTERN = /^[a-z][A-Za-z0-9-]{0,62}$/u

export const DEFAULT_ACTOR_METHOD_TIMEOUT_MS = 300_000

export const actorMethodTimeoutOf = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_ACTOR_METHOD_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("actor method timeoutMs must be a positive safe integer")
  }
  return resolved
}

// ActorMethodDeclaration is the erased shape a heterogeneous method table preserves. eventOf validates unknown input before constructing the durable event.
export interface ActorMethodDeclaration {
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly output: Schema.ConstraintDecoder<unknown>
  readonly timeoutMs: number
  readonly eventOf: (call: ActorMethodCall<unknown>) => Event
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<unknown> | undefined
}

// ActorMethodDefinition declares one typed call as an input event and a result projection.
export interface ActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs?: number
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<Output["Type"]> | undefined
}

// ActorMethod carries a typed definition and its dynamically callable event builder.
export interface ActorMethod<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>
> extends ActorMethodDefinition<Input, Output>, ActorMethodDeclaration {
  readonly input: Input
  readonly output: Output
  readonly timeoutMs: number
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<Output["Type"]> | undefined
}

export type ActorMethods = Readonly<Record<string, ActorMethodDeclaration>>

export type ActorMethodInput<Method extends ActorMethodDeclaration> = Method["input"]["Type"]

export type ActorMethodOutput<Method extends ActorMethodDeclaration> = Method["output"]["Type"]

// actorMethod preserves schema types and adds the validated event builder used after dynamic lookup.
export const actorMethod = <Input extends Schema.ConstraintDecoder<unknown>, Output extends Schema.ConstraintDecoder<unknown>>(
  definition: ActorMethodDefinition<Input, Output>
): ActorMethod<Input, Output> => ({
  ...definition,
  timeoutMs: actorMethodTimeoutOf(definition.timeoutMs),
  eventOf: (call) => definition.event({
    ...call,
    input: Schema.decodeUnknownSync(definition.input)(call.input)
  })
})

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
    if (typeof candidate.eventOf !== "function" || typeof candidate.state !== "function") {
      throw new Error(`actor method ${JSON.stringify(name)} must declare eventOf and state functions`)
    }
    const previous = names.get(declaration)
    if (previous !== undefined) {
      throw new Error(`actor methods ${JSON.stringify(previous)} and ${JSON.stringify(name)} share one declaration`)
    }
    names.set(declaration, name)
  }
  return methods
}
