import { Schema } from "effect"
import { ThreadAddress } from "../communication/endpoint"

// ChildKey identifies a child within its parent's thread namespace.
export const ChildKey = Schema.NonEmptyString.pipe(Schema.brand("ChildKey"))
export type ChildKey = typeof ChildKey.Type

// ThreadId identifies a thread within an actor instance.
export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type

// childKeyOf validates a creator-supplied child key.
export const childKeyOf = Schema.decodeUnknownSync(ChildKey)

// threadIdOf validates a caller-supplied thread identifier.
export const threadIdOf = Schema.decodeUnknownSync(ThreadId)

// childThreadId derives a fixed-width identifier from the complete parent address and child key (identity.test.ts).
export const childThreadId = async (coordinates: {
  readonly parent: ThreadAddress
  readonly child: ChildKey
}): Promise<ThreadId> => {
  const parent = Schema.decodeSync(ThreadAddress)(coordinates.parent)
  const actor = Schema.decodeSync(Schema.NonEmptyString)(parent.actor)
  const thread = threadIdOf(parent.thread)
  const child = childKeyOf(coordinates.child)
  const encoded = JSON.stringify(["child-thread", actor, parent.instance, thread, child])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return threadIdOf(hex)
}
