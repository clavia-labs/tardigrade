import { Effect, Schema } from "effect"
import { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { childKeyOf, threadIdOf, type ThreadId } from "@clavia/tardigrade-core/actor/coordinate"
import type { ChildThreadRequest, ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"

// childThreadId hashes a logical spawn into a bounded ref (allocation.test.ts).
// Separation assumes no SHA-256 collision.
export const childThreadId = async (request: ChildThreadRequest): Promise<ThreadId> => {
  const parent = Schema.decodeSync(ThreadCoordinate)(request.parent)
  const actor = Schema.decodeSync(Schema.NonEmptyString)(parent.actor)
  const thread = threadIdOf(parent.thread)
  const child = childKeyOf(request.child)
  const encoded = JSON.stringify(["child-thread", actor, parent.instance, thread, child])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return threadIdOf(hex)
}

// DEFAULT_THREAD_ALLOCATOR preserves root refs and assigns hashed children, reserving lowercase 64-hex refs for children (allocation.test.ts).
export const DEFAULT_THREAD_ALLOCATOR = {
  allocate: (request: ThreadAllocation): Effect.Effect<ThreadCoordinate> => request.kind === "root"
    ? Effect.sync(() => {
        if (/^[0-9a-f]{64}$/.test(request.coordinate.thread)) throw new Error("root ref is reserved for hashed child allocation")
        return request.coordinate
      })
    : Effect.promise(async () => ({ ...request.parent, thread: await childThreadId(request) }))
}
