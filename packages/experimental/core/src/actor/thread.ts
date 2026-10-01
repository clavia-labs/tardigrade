import { Schema } from "effect"

export const ThreadCoordinate = Schema.Struct({ actor: Schema.NonEmptyString, instance: Schema.NonEmptyString, thread: Schema.NonEmptyString })
export type ThreadCoordinate = typeof ThreadCoordinate.Type

export const ChildPlacement = Schema.Literals(["colocated", "independent"])
export type ChildPlacement = typeof ChildPlacement.Type
export const ThreadDepth = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("ThreadCreated"),
  address: ThreadCoordinate,
  parent: Schema.NullOr(ThreadCoordinate),
  depth: ThreadDepth,
  placement: ChildPlacement,
}).check(Schema.makeFilter(created => created.parent === null ? created.depth === 0 : created.depth > 0 && (
  created.address.actor !== created.parent.actor || created.address.instance !== created.parent.instance || created.address.thread !== created.parent.thread
), { title: "Root depth is zero; children have positive depth and a distinct parent address" }))
export type ThreadCreated = typeof ThreadCreated.Type
