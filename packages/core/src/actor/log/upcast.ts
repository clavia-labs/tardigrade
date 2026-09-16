import type { ThreadAllocation } from "../allocation"
import { childKeyOf, type ThreadCoordinate } from "../coordinate"
import type { ChildPlacement } from "../../interaction/relations"

interface StoredThreadRequest {
  readonly allocationRequest?: ThreadAllocation
  readonly parentThread?: unknown
  readonly placement?: unknown
  readonly depth?: unknown
}

interface ReadThreadRequest {
  readonly allocationRequest?: ThreadAllocation
  readonly parentThread?: string
  readonly placement?: ChildPlacement
  readonly depth?: number
}

// upcastThreadRequest reads historical lineage as metadata without changing stored events (upcast.test.ts).
export const upcastThreadRequest = (stored: StoredThreadRequest): ReadThreadRequest => {
  const request = stored.allocationRequest
  if (request !== undefined) return {
    allocationRequest: request,
    ...(request.kind === "child" ? {
      parentThread: request.parent.thread,
      ...(request.placement === undefined ? {} : { placement: request.placement })
    } : {})
  }
  return {
    ...(typeof stored.parentThread === "string" ? { parentThread: stored.parentThread } : {}),
    ...(stored.placement === "colocated" || stored.placement === "independent" ? { placement: stored.placement } : {}),
    ...(typeof stored.depth === "number" ? { depth: stored.depth } : {})
  }
}

// threadRequestOf resolves recorded creation inputs within the owning actor without inventing fork checkpoints (upcast.test.ts).
export const threadRequestOf = (target: ThreadCoordinate, stored: StoredThreadRequest = {}): ThreadAllocation => {
  const record = upcastThreadRequest(stored)
  return record.allocationRequest ?? (record.parentThread === undefined
    ? { kind: "root", coordinate: target }
    : { kind: "child", parent: { ...target, thread: record.parentThread }, child: childKeyOf(target.thread),
      ...(record.placement === undefined ? {} : { placement: record.placement }) })
}
