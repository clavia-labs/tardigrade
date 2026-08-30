import { Schema } from "effect"
import type { Event } from "../../log/event"

const InvocationEpoch = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "at or above zero" }))
)

export const ActorInvocationSchema = Schema.Struct({
  method: Schema.String,
  id: Schema.String,
  epoch: InvocationEpoch
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

const sameInvocation = (left: ActorInvocation, right: ActorInvocation): boolean =>
  left.method === right.method && left.id === right.id && left.epoch === right.epoch

// actorInvocationContextOf returns the durable context accepted for one invocation.
export const actorInvocationContextOf = (
  events: ReadonlyArray<Event>,
  invocation: ActorInvocation
): ActorInvocationContext | undefined => events.flatMap((event) => {
  const candidate = (event as { readonly call?: unknown }).call
  if (typeof candidate !== "object" || candidate === null) return []
  const context = candidate as Partial<ActorInvocationContext>
  return context.invocation !== undefined && sameInvocation(context.invocation, invocation)
    ? [{
        invocation: context.invocation,
        ...(context.parent === undefined ? {} : { parent: context.parent }),
        ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt })
      }]
    : []
})[0]

// methodIngressKeyOf identifies a linked method invocation independently of the domain event it accepts.
export const methodIngressKeyOf = (event: Event): string | undefined => {
  const value = event as { readonly call?: unknown }
  if (typeof value.call !== "object" || value.call === null) return undefined
  const context = value.call as { readonly invocation?: unknown }
  if (typeof context.invocation !== "object" || context.invocation === null) return undefined
  const invocation = context.invocation as { readonly method?: unknown; readonly id?: unknown; readonly epoch?: unknown }
  if (typeof invocation.method !== "string" || typeof invocation.id !== "string" ||
    typeof invocation.epoch !== "number" || !Number.isSafeInteger(invocation.epoch) || invocation.epoch < 0) return undefined
  return `ming:${JSON.stringify([invocation.method, invocation.id, invocation.epoch])}`
}
