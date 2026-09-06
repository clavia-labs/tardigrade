import type { InvocationCoordinate } from "@clavia/tardigrade-core/interaction"
import type { ActorCallRef } from "./client"

// httpCallOf converts invocation references and legacy current-epoch handles into HTTP coordinates.
export const httpCallOf = (handle: ActorCallRef | InvocationCoordinate) => {
  const reference = "target" in handle ? handle : handle.reference
  if (reference === undefined) {
    const legacy = handle as ActorCallRef
    return { actor: legacy.actor, thread: legacy.thread, method: legacy.method, id: legacy.id }
  }
  const { target, invocation } = reference
  if (!("target" in handle) && (handle.actor !== target.instance || handle.thread !== target.thread ||
    handle.method !== invocation.method || handle.id !== invocation.id)) {
    throw new Error("HTTP handle does not match its invocation reference")
  }
  return { actor: target.instance, thread: target.thread, method: invocation.method, id: invocation.id,
    epoch: invocation.epoch, definition: target.actor }
}
