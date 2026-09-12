import { threadCoordinateOf, type ThreadCoordinate, actorCoordinateOf } from "./coordinate"
import type { ActorDefinition } from "./definition"
import type { ActorMethods } from "./method"

// ThreadLocation accepts the current coordinate spelling and the legacy address spelling.
type ThreadLocation = {
  readonly coordinate: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address?: ThreadCoordinate
} | {
  readonly coordinate?: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address: ThreadCoordinate
}

const declarations = Symbol.for("tardigrade/thread-methods")
const creationParents = new WeakMap<object, ThreadCoordinate>()

type DeclaredTarget<Methods extends ActorMethods> = ThreadLocation & { readonly methods: Methods }

// ThreadTarget accepts declaration targets and callable references without treating calls as schemas.
export type ThreadTarget<Methods extends ActorMethods = ActorMethods> = ThreadLocation & (
  { readonly methods: Methods } | { readonly [declarations]: Methods }
)


// targetMethods retrieves declarations for runtime planning and contract validation (reference.test.ts).
export const targetMethods = <Methods extends ActorMethods>(target: ThreadTarget<Methods>): Methods =>
  declarations in target ? target[declarations] : target.methods

export type MethodAliases<Calls> = {
  /** @deprecated Use the callable methods map. */
  readonly [Name in Exclude<keyof Calls, "coordinate" | "address" | "methods" | "then">]: Calls[Name]
}

export type CallableThread<Methods extends ActorMethods, Calls> = {
  readonly coordinate: ThreadCoordinate
  /** @deprecated Use coordinate. */
  readonly address: ThreadCoordinate
  readonly methods: Calls
  readonly [declarations]: Methods
} & MethodAliases<Calls>

// callableThread groups calls under methods and keeps nonconflicting direct aliases (reference.test.ts).
export const callableThread = <Methods extends ActorMethods, Calls extends Readonly<Record<string, unknown>>>(coordinate: ThreadCoordinate, methods: Methods, calls: Calls, creationParent?: ThreadCoordinate): CallableThread<Methods, Calls> => {
  const reference = { coordinate, address: coordinate, methods: calls }
  Object.defineProperty(reference, declarations, { value: methods })
  if (creationParent !== undefined) creationParents.set(reference, creationParent)
  for (const [name, call] of Object.entries(calls)) {
    if (name === "then" || Object.hasOwn(reference, name)) continue
    Object.defineProperty(reference, name, { value: call })
  }
  return reference as CallableThread<Methods, Calls>
}

export const targetCreationParent = (target: ThreadTarget): ThreadCoordinate | undefined =>
  creationParents.get(target)

// targetCoordinate resolves either spelling and rejects conflicting coordinates (reference.test.ts).
export const targetCoordinate = (target: ThreadTarget): ThreadCoordinate => {
  const coordinate = target.coordinate ?? target.address!
  if (target.coordinate !== undefined && target.address !== undefined &&
    (target.coordinate.actor !== target.address.actor || target.coordinate.instance !== target.address.instance || target.coordinate.thread !== target.address.thread)) {
    throw new Error("thread target coordinate and address must agree")
  }
  return coordinate
}

export type ResolvedThreadTarget<Methods extends ActorMethods> = DeclaredTarget<Methods> & {
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
