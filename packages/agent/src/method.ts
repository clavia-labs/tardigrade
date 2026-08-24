import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"

export const ACTOR_METHOD_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

// ActorMethodCall identifies one durable invocation and carries its decoded input.
export interface ActorMethodCall<Input> {
  readonly id: string
  readonly input: Input
  readonly at: number
}

// ActorMethodState reports what the actor's log currently says about an invocation that exists.
export type ActorMethodState<Output> =
  | { readonly status: "pending" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "completed"; readonly output: Output }
  | { readonly status: "failed"; readonly error: string }

// ActorMethodDeclaration is the erased shape a heterogeneous method table preserves. eventOf validates unknown input before constructing the durable event.
export interface ActorMethodDeclaration {
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly output: Schema.Top
  readonly eventOf: (call: ActorMethodCall<unknown>) => Event
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<unknown> | undefined
}

// ActorMethodDefinition declares one typed call as an input event and a result projection.
export interface ActorMethodDefinition<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.Top = Schema.Top
> {
  readonly input: Input
  readonly output: Output
  readonly event: (call: ActorMethodCall<Input["Type"]>) => Event
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<Output["Type"]> | undefined
}

// ActorMethod carries a typed definition and its dynamically callable event builder.
export interface ActorMethod<
  Input extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  Output extends Schema.Top = Schema.Top
>
  extends ActorMethodDefinition<Input, Output>, ActorMethodDeclaration {
  readonly input: Input
  readonly output: Output
  readonly state: (events: ReadonlyArray<Event>, id: string) => ActorMethodState<Output["Type"]> | undefined
}

export type ActorMethods = Readonly<Record<string, ActorMethodDeclaration>>

export type ActorMethodInput<Method extends ActorMethodDeclaration> = Method["input"]["Type"]

export type ActorMethodOutput<Method extends ActorMethodDeclaration> = Method["output"]["Type"]

// actorMethod preserves the schema types and adds the validated event builder used after dynamic lookup.
export const actorMethod = <Input extends Schema.ConstraintDecoder<unknown>, Output extends Schema.Top>(
  definition: ActorMethodDefinition<Input, Output>
): ActorMethod<Input, Output> => ({
  ...definition,
  eventOf: (call) => definition.event({
    ...call,
    input: Schema.decodeUnknownSync(definition.input)(call.input)
  })
})

// actorMethodsOf validates the names that later invocation surfaces expose.
export const actorMethodsOf = <const Methods extends ActorMethods>(methods: Methods): Methods => {
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
    if (typeof candidate.eventOf !== "function" || typeof candidate.state !== "function") {
      throw new Error(`actor method ${JSON.stringify(name)} must declare eventOf and state functions`)
    }
  }
  return methods
}
