import { Schema } from "effect"

// AbortReceived records an actor stop signal; its invocation identifies the method operation to stop.
export const AbortReceived = Schema.Struct({ type: Schema.Literal("AbortReceived"), reason: Schema.String, invocation: Schema.Struct({ method: Schema.NonEmptyString, id: Schema.NonEmptyString }) })
export type AbortReceived = typeof AbortReceived.Type
