import type { Effect } from "effect"
import type { ModelRef } from "./reference"

// InferenceIdentity identifies the actor turn that opened a logical model attempt (index.test.ts, "root and child inference requests carry their actor identity").
export interface InferenceIdentity {
  readonly actor: string
  readonly thread: string
  readonly turn: string
}

// InferDelta is ephemeral normalized text from one physical provider request. Sequence is zero-based within that request, so a consumer can detect a dropped delta (model.test.ts, "observes normalized text without changing the terminal action").
export interface InferDelta extends InferenceIdentity {
  readonly logicalAttempt: string
  readonly physicalAttempt: string
  readonly model: ModelRef
  readonly blockIndex: number
  readonly sequence: number
  readonly text: string
}

// InferenceObserver receives ephemeral output outside the durable log. Failure and timeout discard that delivery without changing inference (model.test.ts, "observer failure and saturation leave inference unchanged").
export interface InferenceObserver {
  readonly onDelta: (delta: InferDelta) => Effect.Effect<void, Error>
  readonly policy?: Partial<InferenceObserverPolicy>
}

// InferenceObserverPolicy bounds pending deliveries and each observer call.
export interface InferenceObserverPolicy {
  readonly bufferCapacity: number
  readonly deliveryTimeoutMs: number
}

// DEFAULT_INFERENCE_OBSERVER_POLICY bounds best-effort delivery while each observer may override both fields.
export const DEFAULT_INFERENCE_OBSERVER_POLICY: InferenceObserverPolicy = {
  bufferCapacity: 64,
  deliveryTimeoutMs: 100
}
