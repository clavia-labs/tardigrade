import { JsonSchema, Schema } from "effect"
import type { Event } from "../event"
import { ThreadCoordinate } from "../actor/coordinate"

// InvocationRef identifies a method execution within its owning thread.
export const InvocationRef = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: Schema.Int.pipe(Schema.check(Schema.makeFilter((value: number) => value >= 0, {
    title: "at or above zero",
    toJsonSchema: () => ({ minimum: 0 })
  })))
})

export type InvocationRef = typeof InvocationRef.Type

// invocationKey identifies an invocation within its owning thread (interaction.properties.test.ts).
export const invocationKey = (invocation: InvocationRef): string =>
  JSON.stringify([invocation.method, invocation.id, invocation.epoch])

// sameInvocation compares execution coordinates within one thread.
export const sameInvocation = (left: InvocationRef, right: InvocationRef): boolean =>
  left.method === right.method && left.id === right.id && left.epoch === right.epoch

// InvocationCoordinate identifies a method execution at its target thread.
export const InvocationCoordinate = Schema.Struct({
  target: ThreadCoordinate,
  invocation: InvocationRef
})
export type InvocationCoordinate = typeof InvocationCoordinate.Type

// invocationCoordinateOf composes a thread coordinate and its locally scoped invocation ref.
export const invocationCoordinateOf = (target: ThreadCoordinate, invocation: InvocationRef): InvocationCoordinate =>
  Schema.decodeSync(InvocationCoordinate)({ target, invocation })

export const decodeInvocationCoordinate = Schema.decodeUnknownSync(InvocationCoordinate)

// invocationCoordinateJsonSchema embeds the reference schema without root-relative definitions.
export const invocationCoordinateJsonSchema: JsonSchema.JsonSchema = (() => {
  const document = Schema.toJsonSchemaDocument(InvocationCoordinate)
  return JSON.parse(JSON.stringify(document.schema, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || !("$ref" in value) || typeof value.$ref !== "string") return value
    const { $ref, ...siblings } = value
    const resolved = JsonSchema.resolve$ref($ref, document.definitions)
    if (resolved === undefined) throw new Error(`unresolved invocation schema reference ${$ref}`)
    return { ...resolved, ...siblings }
  })) as JsonSchema.JsonSchema
})()

// invocationCoordinateKey preserves every target and invocation coordinate (interaction.properties.test.ts).
export const invocationCoordinateKey = (reference: InvocationCoordinate): string => {
  const { target, invocation } = decodeInvocationCoordinate(reference)
  return JSON.stringify([target.actor, target.instance, target.thread, invocation.method, invocation.id, invocation.epoch])
}

// invocationResponseId identifies the terminal awaited for an exact invocation (interaction.properties.test.ts).
export const invocationResponseId = (reference: InvocationCoordinate): string => `response:${invocationCoordinateKey(reference)}`

// invocationIdForKey scopes an idempotency key to a complete parent invocation (idempotency.properties.test.ts; packages/host/tla/Identity.tla, CallSeparation).
export const invocationIdForKey = (parent: InvocationCoordinate, key: string): string =>
  JSON.stringify(["invocation", invocationCoordinateKey(parent), Schema.decodeSync(Schema.NonEmptyString)(key)])

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, {
    title: "at or above zero",
    toJsonSchema: () => ({ minimum: 0 })
  }))
)

export const ActorInvocationContextSchema = Schema.Struct({
  invocation: InvocationRef,
  parent: Schema.optional(InvocationRef),
  deadlineAt: Schema.optional(NonNegativeInt)
})

// ActorInvocationContext carries the durable execution scope shared by a method invocation and its descendants.
export interface ActorInvocationContext {
  readonly invocation: InvocationRef
  readonly parent?: InvocationRef
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

// actorInvocationContextFrom decodes the complete durable context carried by an event.
export const actorInvocationContextFrom = (event: Event): ActorInvocationContext | undefined => {
  const candidate = (event as { readonly call?: unknown }).call
  return Schema.is(ActorInvocationContextSchema)(candidate) ? normalizedContext(candidate) : undefined
}

// actorInvocationContextOf returns the durable context accepted for one invocation.
export const actorInvocationContextOf = (
  events: ReadonlyArray<Event>,
  invocation: InvocationRef
): ActorInvocationContext | undefined => events.flatMap((event) => {
  const context = actorInvocationContextFrom(event)
  return context !== undefined && sameInvocation(context.invocation, invocation) ? [context] : []
})[0]

// methodIngressKeyOf identifies a linked method invocation independently of the domain event it accepts.
export const methodIngressKeyOf = (event: Event): string | undefined => {
  const invocation = actorInvocationContextFrom(event)?.invocation
  if (invocation === undefined) return undefined
  return `ming:${invocationKey(invocation)}`
}

export { InvocationRef as ActorInvocationSchema }
export type ActorInvocation = InvocationRef
