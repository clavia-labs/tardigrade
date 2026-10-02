import type { Link } from "./link"

// Envelope carries an addressed payload without interpreting its protocol.
export interface Envelope<Source = unknown, Payload = unknown, Target = unknown> {
  readonly link: Link<Source, Target>
  readonly event: Payload
}

// envelopeOf pairs a payload with its delivery endpoints.
export const envelopeOf = <Source, Target, Payload>(link: Link<Source, Target>, event: Payload): Envelope<Source, Payload, Target> => ({ link, event })
