import { isMessageReceived } from "../actor/message"
import type { Recorded, RuntimeEvent, ObservedRecord, RecordMetadata } from "../services/journal"

// recordEvent unwraps inbound actor messages while retaining reply envelopes (platform/test/properties/runtime/input-representation.ts).
export function recordEvent<Event>(record: Recorded<Event>): RuntimeEvent<Event>
export function recordEvent<Event>(record: ObservedRecord<Event>): ObservedRecord<Event>["event"]
export function recordEvent(record: { readonly event: unknown; readonly message?: { readonly inReplyTo?: unknown } }): unknown {
  return isMessageReceived(record.event) && !record.message?.inReplyTo ? record.event.body : record.event
}

// recordMetadata selects delivery context and journal time for reducers (platform/test/properties/runtime/atom-checkpoint.ts).
export const recordMetadata = (record: RecordMetadata | undefined): RecordMetadata => ({ ...(record?.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), ...(record?.message ? { message: record.message } : {}) })
