import { Schema } from "effect"

/**
 * Event is the smallest data primitive in Tardigrade
 * Every event has a string type and may carry additional fields.
 * Its open shape lets consumers define domain-specific events.
 * Projections are machines that take events as input.
 */
export const Event = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown)
])
export type Event = typeof Event.Type
