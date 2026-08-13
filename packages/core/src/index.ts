// The public surface of @flamecast/core. This is the one file in the package that re-exports:
// every doc snippet imports from "@flamecast/core", and a library owes its consumers one door.
// Inside the package, a module imports from the file that defines the symbol.

export type { Envelope } from "./envelope"
export { EventLog, dedupKey, type DedupKey, type EventLogStore } from "./event-log"
export {
  erase,
  foldOf,
  machine,
  resting,
  settle,
  settleAll,
  stateOf,
  type Fold,
  type Machine,
  type StateDef,
  type Transition
} from "./machine"
export { actor, send, Self, type Actor } from "./actor"
export { Router } from "./router"
export { Placement, Sink, Spill, Wake, Writer, type SinkRecord } from "./ports"
export {
  conformance,
  type Check,
  type ConformanceOptions,
  type ConformanceReport
} from "./conformance"
