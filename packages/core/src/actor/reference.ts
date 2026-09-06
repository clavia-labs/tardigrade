import { threadCoordinateOf, type ThreadCoordinate, actorCoordinateOf } from "./coordinate"

import type { ActorDefinition } from "./definition"
import type { Effect } from "effect"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "./method"
import { invokeMethod, type InvocationOptions, type InvocationFailed, type InvocationCancelled, type InvocationScope } from "../interaction/execution"
import type { EventLog } from "../log"
import type { Router } from "../transport/router"
import type { Self } from "../runtime/reconciler"

// ThreadTarget pairs a thread coordinate with its method declarations.
// Its address and method declarations carry no authority to access the target.
// TODO: Add transferable capabilities beside coordinates, scoped to target and operation.
export interface ThreadTarget<Methods extends ActorMethods = ActorMethods> {
  readonly address: ThreadCoordinate
  readonly methods: Methods
}

// threadTarget pairs an actor's method declarations with a thread coordinate.
export const threadTarget = <Methods extends ActorMethods>(
  actor: Pick<ActorDefinition<Methods>, "name" | "methods">,
  instance: string,
  thread: string
): ThreadTarget<Methods> => ({
  address: threadCoordinateOf(actorCoordinateOf(actor.name, instance), thread),
  methods: actor.methods
})

// ThreadRef exposes the actor's declared methods as callable Effects.
export type ThreadRef<Methods extends ActorMethods> = ThreadTarget<Methods> & {
  readonly [Name in keyof Methods]: (
    input: ActorMethodInput<Methods[Name]>, options: InvocationOptions
  ) => Effect.Effect<ActorMethodOutput<Methods[Name]>, InvocationFailed | InvocationCancelled, InvocationScope | EventLog | Router | Self>
}

// bindThreadMethods exposes declared methods as replayable calls on a thread reference.
export const bindThreadMethods = <Methods extends ActorMethods>(reference: ThreadTarget<Methods>, creationParent?: ThreadCoordinate): ThreadRef<Methods> => {
  const calls: Record<string, unknown> = Object.create(null)
  for (const name of Object.keys(reference.methods)) {
    if (name === "address" || name === "methods" || name === "then") {
      throw new Error(`method ${JSON.stringify(name)} conflicts with the thread reference surface`)
    }
    calls[name] = (input: ActorMethodInput<Methods[typeof name]>, options: InvocationOptions) =>
      invokeMethod(reference, name as Extract<keyof Methods, string>, input, options, creationParent)
  }
  return { ...reference, ...calls } as ThreadRef<Methods>
}
