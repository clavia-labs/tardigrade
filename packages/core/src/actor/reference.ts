import type { ThreadCoordinate } from "./coordinate"

import type { Effect } from "effect"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "./method"
import { invokeMethod, type InvocationOptions, type InvocationFailed, type InvocationCancelled, type InvocationScope } from "../interaction/execution"
import type { EventLog } from "../log"
import type { Router } from "../transport/router"
import type { Self } from "../runtime/reconciler"

export { targetCoordinate, threadTarget, type ThreadTarget } from "./target"
import { targetCoordinate, type ThreadTarget, type ResolvedThreadTarget } from "./target"

// ThreadRef exposes the actor's declared methods as callable Effects.
export type ThreadRef<Methods extends ActorMethods> = ResolvedThreadTarget<Methods> & {
  readonly [Name in keyof Methods]: (
    input: ActorMethodInput<Methods[Name]>, options: InvocationOptions
  ) => Effect.Effect<ActorMethodOutput<Methods[Name]>, InvocationFailed | InvocationCancelled, InvocationScope | EventLog | Router | Self>
}

// bindThreadMethods exposes declared methods as replayable calls on a thread reference.
export const bindThreadMethods = <Methods extends ActorMethods>(reference: ThreadTarget<Methods>, creationParent?: ThreadCoordinate): ThreadRef<Methods> => {
  const coordinate = targetCoordinate(reference)
  const calls: Record<string, unknown> = Object.create(null)
  for (const name of Object.keys(reference.methods)) {
    if (name === "coordinate" || name === "address" || name === "methods" || name === "then") {
      throw new Error(`method ${JSON.stringify(name)} conflicts with the thread reference surface`)
    }
    calls[name] = (input: ActorMethodInput<Methods[typeof name]>, options: InvocationOptions) =>
      invokeMethod(reference, name as Extract<keyof Methods, string>, input, options, creationParent)
  }
  return { ...reference, coordinate, address: coordinate, ...calls } as ThreadRef<Methods>
}
