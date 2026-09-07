import { threadCoordinateOf, type ThreadCoordinate, actorCoordinateOf } from "./coordinate"
import type { ActorDefinition } from "./definition"
import type { ActorMethods } from "./method"

// ThreadTarget pairs a thread coordinate with its method declarations.
// Its coordinate and method declarations carry no authority to access the target.
// TODO: Add transferable capabilities beside coordinates, scoped to target and operation.
export type ThreadTarget<Methods extends ActorMethods = ActorMethods> = {
  readonly methods: Methods
} & ({
  readonly coordinate: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address?: ThreadCoordinate
} | {
  readonly coordinate?: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address: ThreadCoordinate
})

// targetCoordinate resolves either spelling and rejects conflicting coordinates (reference.test.ts).
export const targetCoordinate = (target: ThreadTarget): ThreadCoordinate => {
  const coordinate = target.coordinate ?? target.address!
  if (target.coordinate !== undefined && target.address !== undefined &&
    (target.coordinate.actor !== target.address.actor || target.coordinate.instance !== target.address.instance || target.coordinate.thread !== target.address.thread)) {
    throw new Error("thread target coordinate and address must agree")
  }
  return coordinate
}

export type ResolvedThreadTarget<Methods extends ActorMethods> = ThreadTarget<Methods> & {
  readonly coordinate: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address: ThreadCoordinate
}

// threadTarget pairs an actor's method declarations with a thread coordinate.
export const threadTarget = <Methods extends ActorMethods>(
  actor: Pick<ActorDefinition<Methods>, "name" | "methods">,
  instance: string,
  thread: string
): ResolvedThreadTarget<Methods> => {
  const coordinate = threadCoordinateOf(actorCoordinateOf(actor.name, instance), thread)
  return { coordinate, address: coordinate, methods: actor.methods }
}

