import { Cause, Data, Schema } from "effect"

export const EffectRef = Schema.Struct({
  seq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  atom: Schema.NonEmptyString,
  act: Schema.NonEmptyString,
})
export type EffectRef = typeof EffectRef.Type

export const effectKey = (ref: EffectRef) => JSON.stringify([ref.seq, ref.atom, ref.act])

// RuntimeError preserves a typed failure at the runtime boundary.
export class RuntimeError extends Error {
  readonly _tag = "RuntimeError"

  static from(cause: unknown): RuntimeError {
    return cause instanceof RuntimeError ? cause : new RuntimeError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export type ActorReplayFailure = (
  | { readonly stage: "checkpoint"; readonly reason: "decode_failed" | "position_mismatch" }
  | { readonly stage: "event"; readonly reason: "decode_failed" }
  | { readonly stage: "effect_request"; readonly reason: "reconstruction_failed" | "input_mismatch" }
  | { readonly stage: "retained_input"; readonly reason: "unavailable" }
) & { readonly position?: number }

export class ActorReplayError extends RuntimeError {
  override readonly name = "ActorReplayError"
  readonly code = "actor_replay_failed"
  readonly stage: ActorReplayFailure["stage"]
  readonly reason: ActorReplayFailure["reason"]
  readonly position: number | undefined

  constructor(failure: ActorReplayFailure & { readonly cause: unknown }) {
    super(failure.cause instanceof Error ? failure.cause.message : "Actor history could not be replayed", { cause: failure.cause })
    this.stage = failure.stage
    this.reason = failure.reason
    this.position = failure.position
  }

  static wrap(cause: unknown, failure: ActorReplayFailure): ActorReplayError {
    return cause instanceof ActorReplayError ? cause : new ActorReplayError({ ...failure, cause })
  }
}

// AttemptTimedOut reports an expired local attempt without acknowledging remote completion (quint/attemptDeadline.qnt, executionTimeoutRetryTest).
export class AttemptTimedOut extends Schema.TaggedError<AttemptTimedOut>()("AttemptTimedOut", { timeoutMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) }) {
  override get message() { return `Attempt timed out after ${this.timeoutMs}ms` }
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
  Schema.Struct({ type: Schema.Literal("promise"), handle: ExecutionHandle, deadlineAt: Schema.optionalKey(Deadline), unbounded: Schema.optionalKey(Schema.Literal(true)) }).check(Schema.makeFilter(result => !result.unbounded || (result.handle.executor === "local" && result.deadlineAt === undefined), { title: "Unbounded promises require a local producer and no deadline" })),
])
export type ExecutionResult = typeof ExecutionResult.Type

// EffectDied records a terminal execution defect separately from the act's declared failure channel.
export const EffectDied = Schema.Struct({
  type: Schema.Literal("EffectDied"),
  ref: EffectRef,
  diagnostic: Schema.String,
})
export type EffectDied = typeof EffectDied.Type

// EffectCancelled records a terminal local cancellation decision; executor cleanup may still be pending.
export const EffectCancelled = Schema.Struct({ type: Schema.Literal("EffectCancelled"), ref: EffectRef, reason: Schema.Json })
export type EffectCancelled = typeof EffectCancelled.Type

// CancellationSettled records the final cleanup result; only success discharges the input obligation (quint/workLifecycle.qnt, cleanupDischargeSound).
export const CancellationSettled = Schema.Struct({
  type: Schema.Literal("CancellationSettled"), ref: EffectRef,
  outcome: Schema.Union([Schema.Struct({ status: Schema.Literal("fulfilled") }), Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.String })]),
})
export type CancellationSettled = typeof CancellationSettled.Type

// CancellationDied records a cleanup defect while preserving its input obligation (quint/workLifecycle.qnt, cleanupDeathTest).
export const CancellationDied = Schema.Struct({ type: Schema.Literal("CancellationDied"), ref: EffectRef, diagnostic: Schema.String })
export type CancellationDied = typeof CancellationDied.Type
export const CancellationOutcome = Schema.Union([CancellationSettled, CancellationDied])
export type CancellationOutcome = typeof CancellationOutcome.Type

export const Cancelled = Schema.TaggedStruct("Cancelled", { reason: Schema.Json })
export type Cancelled = typeof Cancelled.Type
