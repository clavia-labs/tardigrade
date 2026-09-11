import { Cause, Effect, Fiber, Queue, Stream } from "effect"
import { DEFAULT_INFERENCE_OBSERVER_POLICY, type InferDelta, type InferenceObserver, type InferenceObserverPolicy } from "@clavia/tardigrade-agent"

export interface DeltaDelivery {
  readonly offer: (delta: InferDelta) => Effect.Effect<boolean>
  readonly finish: Effect.Effect<void>
}

export const observerPolicyOf = (observer: InferenceObserver): InferenceObserverPolicy => {
  const policy = { ...DEFAULT_INFERENCE_OBSERVER_POLICY, ...observer.policy }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`inference observer ${name} must be a positive integer, got ${value}`)
    }
  }
  return policy
}

// deltaDelivery drops overflow and interrupts pending deliveries when inference ends (inference/observer.test.ts).
export const deltaDelivery = (
  observer: InferenceObserver,
  policy: InferenceObserverPolicy
): Effect.Effect<DeltaDelivery> =>
  Effect.gen(function*() {
    const queue = yield* Queue.dropping<InferDelta, Cause.Done>(policy.bufferCapacity)
    const worker = yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((delta) =>
        Effect.suspend(() => observer.onDelta(delta)).pipe(
          Effect.timeout(policy.deliveryTimeoutMs),
          Effect.ignoreCause
        )
      ),
      Effect.forkChild
    )
    return {
      offer: (delta) => Queue.offer(queue, delta).pipe(Effect.tap(() => Effect.yieldNow)),
      finish: Queue.end(queue).pipe(
        Effect.andThen(Fiber.interrupt(worker)),
        Effect.ignoreCause
      )
    }
  })
