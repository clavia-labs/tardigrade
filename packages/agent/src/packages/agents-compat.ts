import { ChildCreated } from "@clavia/tardigrade-core/interaction/relations"
import { invocationCoordinateOf, type InvocationCoordinate } from "@clavia/tardigrade-core/interaction"

// childInvocationRef returns the invocation recorded for a child, defaulting legacy records to epoch zero.
export const childInvocationRef = (record: ChildCreated): InvocationCoordinate => invocationCoordinateOf(
  record.address, record.invocation ?? { method: "message", id: record.callId, epoch: 0 }
)
