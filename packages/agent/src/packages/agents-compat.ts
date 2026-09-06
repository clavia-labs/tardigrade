import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { ChildCreated } from "@clavia/tardigrade-core/interaction/relations"
import { invocationCoordinateOf, type InvocationCoordinate } from "@clavia/tardigrade-core/interaction"

// childInvocationRef returns the invocation recorded for a child, defaulting legacy records to epoch zero.
export const childInvocationRef = (record: ChildCreated): InvocationCoordinate => invocationCoordinateOf(
  record.address, record.invocation ?? { method: "message", id: record.callId, epoch: 0 }
)

// legacyChildHandle resolves a call-ID-only handle only when one recorded dispatch owns it (agents-compat.test.ts).
export const legacyChildHandle = (events: ReadonlyArray<Event>, id: string): ChildCreated | { readonly error: string } => {
  const candidates = events.filter((event): event is ChildCreated => Schema.is(ChildCreated)(event) && event.callId === id)
  if (candidates.length === 0) return { error: `no recorded child dispatch for ${JSON.stringify(id)}` }
  if (candidates.length !== 1) return { error: `ambiguous child dispatch ${JSON.stringify(id)}; pass the invocation handle returned by agents.run` }
  return candidates[0]!
}
