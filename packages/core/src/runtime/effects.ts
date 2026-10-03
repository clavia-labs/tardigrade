import { Cause, Data, Schema } from "effect"

export const EffectRef = Schema.Struct({
  seq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  atom: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
})
export type EffectRef = typeof EffectRef.Type

export const effectKey = (ref: EffectRef) => JSON.stringify([ref.seq, ref.atom, ref.tag])

// RuntimeError preserves a typed failure at the runtime boundary.
export class RuntimeError extends Error {
  readonly _tag = "RuntimeError"

  static from(cause: unknown): RuntimeError {
    return cause instanceof RuntimeError ? cause : new RuntimeError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

// ActorCommitError latches a failed journal commit and retains its full Effect cause for diagnostics.
export class ActorCommitError extends Data.TaggedError("ActorCommitError")<{
  readonly message: "Actor state could not be persisted; recreate the actor store before retrying"
  readonly position: number
  readonly operation: "append" | "checkpoint"
  readonly cause: Cause.Cause<unknown>
}> {}

// PromiseNotReady rejects delivery until the accepted effect has a recorded settlement.
export class PromiseNotReady extends RuntimeError {
  constructor(readonly ref: EffectRef) {
    super("Promise delivery requires effect settlement first")
  }
}

export const Deadline = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8_640_000_000_000_000))
export const PromiseTimedOut = Schema.TaggedStruct("PromiseTimedOut", { deadlineAt: Deadline })
export type PromiseTimedOut = typeof PromiseTimedOut.Type
export const ClockHandle = Schema.Struct({ executor: Schema.Literal("clock"), id: Schema.NonEmptyString, at: Deadline, value: Schema.optionalKey(Schema.Json) })
export type ClockHandle = typeof ClockHandle.Type
export const ExecutionHandle = Schema.Struct({ executor: Schema.NonEmptyString, id: Schema.NonEmptyString, endpoint: Schema.optionalKey(Schema.NonEmptyString), mode: Schema.optionalKey(Schema.Literals(["poll", "push"])), at: Schema.optionalKey(Deadline), value: Schema.optionalKey(Schema.Json) }).check(Schema.makeFilter(handle => handle.executor !== "clock" || handle.at !== undefined, { title: "Clock handles require a deadline" }))
export type ExecutionHandle = typeof ExecutionHandle.Type

export const FiberHandle = Schema.Struct({ executor: Schema.Literal("local"), id: Schema.NonEmptyString })
export type FiberHandle = typeof FiberHandle.Type

// ExecutionResult distinguishes an immediate value from a handle to an eventual result.
export const ExecutionResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("value"), value: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("promise"), handle: ExecutionHandle, deadlineAt: Schema.optionalKey(Deadline) }),
])
export type ExecutionResult = typeof ExecutionResult.Type

// EffectCancelled records a terminal local cancellation decision; executor cleanup may still be pending.
export const EffectCancelled = Schema.Struct({ type: Schema.Literal("EffectCancelled"), ref: EffectRef, reason: Schema.Json })
export type EffectCancelled = typeof EffectCancelled.Type

export const Cancelled = Schema.TaggedStruct("Cancelled", { reason: Schema.Json })
export type Cancelled = typeof Cancelled.Type
