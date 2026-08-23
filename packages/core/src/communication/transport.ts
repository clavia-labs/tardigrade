import type { Effect } from "effect"
import type { RoutedEnvelope } from "./envelope"

// Transport carries unchanged envelopes over one named physical path.
export interface Transport<Destination, E extends RoutedEnvelope = RoutedEnvelope> {
  readonly name: string
  readonly send: (destination: Destination, envelope: E) => Effect.Effect<void>
}
