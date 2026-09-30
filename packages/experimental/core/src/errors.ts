import type { EffectRef } from "./effect-ref"

// RuntimeError preserves a typed failure at the experimental runtime boundary.
export class RuntimeError extends Error {
  readonly _tag = "RuntimeError"

  static from(cause: unknown): RuntimeError {
    return cause instanceof RuntimeError ? cause : new RuntimeError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

// PromiseNotReady rejects delivery until the accepted effect has a recorded settlement.
export class PromiseNotReady extends RuntimeError {
  constructor(readonly ref: EffectRef) {
    super("Promise delivery requires effect settlement first")
  }
}
