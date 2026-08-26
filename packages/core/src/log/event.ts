import { Schema } from "effect"

// Event is the open event shape, the only one core knows. Every stored event decodes
// through it, so unknown types survive a read (tolerant reads, upcast-on-read). Consumers
// narrow on type.
export const Event = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown)
])
export type Event = typeof Event.Type
