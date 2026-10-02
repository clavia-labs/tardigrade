import type { Effect } from "effect"
import type { Envelope } from "./envelope"

// Transport carries unchanged envelopes over one named physical path.
export interface Transport<Destination, E extends Envelope = Envelope> {
  readonly name: string
  readonly send: (destination: Destination, envelope: E) => Effect.Effect<void>
}
