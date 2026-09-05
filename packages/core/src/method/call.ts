import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { methodSealOf } from "./seal"

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

export const ActorInvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: NonNegativeInt
})

export const ActorInvocationContextSchema = Schema.Struct({
  invocation: ActorInvocationSchema,
  parent: Schema.optional(ActorInvocationSchema),
  deadlineAt: Schema.optional(NonNegativeInt)
})

// ActorInvocation identifies one execution epoch of a durable actor method call.
export interface ActorInvocation {
  readonly method: string
  readonly id: string
  readonly epoch: number
}

// ActorInvocationContext carries the durable execution scope shared by a method invocation and its descendants.
export interface ActorInvocationContext {
  readonly invocation: ActorInvocation
  readonly parent?: ActorInvocation
  readonly deadlineAt?: number
}

// ActorMethodCall identifies one durable invocation and carries its decoded input.
export interface ActorMethodCall<Input> extends ActorInvocationContext {
  readonly input: Input
  readonly at: number
}

const normalizedContext = (context: typeof ActorInvocationContextSchema.Type): ActorInvocationContext => ({
  invocation: context.invocation,
  ...(context.parent === undefined ? {} : { parent: context.parent }),
  ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt })
})

// decodeActorInvocationContext validates and normalizes a complete durable invocation context.
export const decodeActorInvocationContext = (value: unknown): ActorInvocationContext =>
  normalizedContext(Schema.decodeUnknownSync(ActorInvocationContextSchema)(value))

const sameInvocation = (left: ActorInvocation, right: ActorInvocation): boolean =>
  left.method === right.method && left.id === right.id && left.epoch === right.epoch

// actorInvocationContextFrom decodes the complete durable context carried by an event.
export const actorInvocationContextFrom = (event: Event): ActorInvocationContext | undefined => {
  const candidate = (event as { readonly call?: unknown }).call
  return Schema.is(ActorInvocationContextSchema)(candidate) ? normalizedContext(candidate) : undefined
}

// actorInvocationContextOf returns the durable context accepted for one invocation.
export const actorInvocationContextOf = (
  events: ReadonlyArray<Event>,
  invocation: ActorInvocation
): ActorInvocationContext | undefined => events.flatMap((event) => {
  const context = actorInvocationContextFrom(event)
  return context !== undefined && sameInvocation(context.invocation, invocation) ? [context] : []
})[0]

// methodSealKey names the durable admission seal of one method on one thread.
export const methodSealKey = (method: string): string => `mseal:${JSON.stringify(method)}`

// methodIngressKeyOf identifies a linked method invocation or a durable admission seal independently of the domain event it accepts.
export const methodIngressKeyOf = (event: Event): string | undefined => {
  const seal = methodSealOf(event)
  if (seal !== undefined) return methodSealKey(seal.method)
  const invocation = actorInvocationContextFrom(event)?.invocation
  if (invocation === undefined) return undefined
  return `ming:${JSON.stringify([invocation.method, invocation.id, invocation.epoch])}`
}
