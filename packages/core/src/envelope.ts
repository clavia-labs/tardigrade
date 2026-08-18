import { Schema } from "effect"

// Envelope is the open event shape, the only one core knows. Every stored event decodes
// through it, so unknown types survive a read (tolerant reads, upcast-on-read). Consumers
// narrow on type.
export const Envelope = Schema.Struct(
  { type: Schema.String },
  { key: Schema.String, value: Schema.Unknown }
)
export type Envelope = typeof Envelope.Type
