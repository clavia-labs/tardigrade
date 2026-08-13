import { D as DedupKey, O as EventLog, a as Placement, c as Spill, d as Router, j as Envelope, l as Wake, o as Sink, p as Self, u as Writer } from "./index-HxZ3VQTk.js";
import { Effect, Layer } from "effect";
//#region packages/runtime-memory/src/runtime.d.ts
interface MemoryOptions {
  readonly keyOf: DedupKey;
  readonly session?: string;
  readonly seed?: ReadonlyArray<Envelope>;
  readonly route?: (address: string, event: Envelope) => Effect.Effect<Envelope>;
}
declare const MemoryRuntime: (options: MemoryOptions) => Layer.Layer<EventLog | Writer | Wake | Placement | Spill | Sink | Router | Self, never, never>;
//#endregion
export { type MemoryOptions, MemoryRuntime };