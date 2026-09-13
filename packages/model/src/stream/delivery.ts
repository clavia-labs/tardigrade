import { IdGenerator, type Response } from "effect/unstable/ai"
import type { ModelRef } from "../reference"
import type { InferenceIdentity } from "./observer"
import { Cause, Effect, Fiber, Queue, Stream } from "effect"
import { DEFAULT_INFERENCE_OBSERVER_POLICY, type InferDelta, type InferenceObserver, type InferenceObserverPolicy } from "./observer"

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

// observeResponse delivers text and reasoning from one physical request (inference/observer.test.ts).
export const observeResponse = (identity: InferenceIdentity, model: ModelRef, key: string | undefined, observer?: InferenceObserver, onDelta?: (delta: InferDelta) => void) => Effect.gen(function* () {
  const delivery = observer === undefined ? undefined : yield* deltaDelivery(observer, observerPolicyOf(observer))
  const physicalAttempt = yield* IdGenerator.defaultIdGenerator.generateId()
  let sequence = 0
  let blockIndex = -1
  return {
    onPart: (part: Response.AnyPart) => {
      if (part.type === "text-start" || part.type === "reasoning-start") blockIndex += 1
      if (part.type !== "text-delta" && part.type !== "reasoning-delta") return Effect.void
      const delta: InferDelta = { ...identity, logicalAttempt: key ?? identity.turn, physicalAttempt, model, blockIndex: Math.max(0, blockIndex), sequence: sequence++, text: part.delta, ...(part.type === "reasoning-delta" ? { kind: "reasoning" as const } : {}) }
      onDelta?.(delta)
      return delivery?.offer(delta).pipe(Effect.asVoid) ?? Effect.void
    },
    finish: delivery?.finish ?? Effect.void
  }
})
