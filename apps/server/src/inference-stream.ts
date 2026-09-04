import { Effect } from "effect"
import type { InferDelta, InferenceObserver } from "tardie"

// InferenceStream fans ephemeral model text out to connected HTTP streams. A subscriber receives
// only deltas produced after it subscribes, so the durable log remains the replay surface.
export interface InferenceStream {
  readonly observer: InferenceObserver
  readonly subscribe: (listener: (delta: InferDelta) => void) => () => void
  readonly subscribers: () => number
}

// makeInferenceStream creates the process-local bridge between the model observer and HTTP. An
// existing observer remains in the delivery path so an embedded host can keep its own telemetry.
export const makeInferenceStream = (existing?: InferenceObserver): InferenceStream => {
  const listeners = new Set<(delta: InferDelta) => void>()
  const observer: InferenceObserver = {
    ...(existing?.policy === undefined ? {} : { policy: existing.policy }),
    onDelta: (delta) => Effect.sync(() => {
      for (const listener of listeners) listener(delta)
    }).pipe(existing === undefined ? (effect) => effect : Effect.andThen(existing.onDelta(delta)))
  }
  return {
    observer,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribers: () => listeners.size
  }
}
