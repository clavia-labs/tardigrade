import { Schema } from "effect"
import type { Event } from "../event"
import { InvocationRef, type InvocationCoordinate, type ActorInvocationContext } from "./invocation"
import type { ActorMethodState } from "./state"

// CallDispatched records that one durable method future was dispatched to its target.
export interface CallDispatched extends Event {
  readonly reference?: InvocationCoordinate
  readonly type: "CallDispatched"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly input: unknown
  readonly epoch?: number
  readonly parent?: InvocationRef
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

// CallPlanned records one outgoing invocation before it can become externally visible.
export interface CallPlanned extends Event {
  readonly reference?: InvocationCoordinate
  readonly type: "CallPlanned"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly input: unknown
  readonly context: ActorInvocationContext
  readonly timeoutMs: number
  readonly at: number
}

// CallSkipped records that an inherited deadline prevented external publication.
export interface CallSkipped extends Event {
  readonly reference?: InvocationCoordinate
  readonly type: "CallSkipped"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly deadlineAt: number
  readonly at: number
}

// ActorMethodResponse is the terminal response correlated to one method call.
export interface ActorMethodResponse<Output = unknown> {
  readonly invocation: InvocationRef
  readonly state: Exclude<ActorMethodState<Output>, { readonly status: "pending" }>
}

// ResponseReceived is a method response accepted into the caller's private log.
export interface ResponseReceived extends Event {
  readonly reference?: InvocationCoordinate
  readonly epoch?: number
  readonly type: "ResponseReceived"
  readonly id: string
  readonly method: string
  readonly call: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly error?: string
  readonly cause?: "requested" | "deadline"
  readonly reason?: string
  readonly deadlineAt?: number
  readonly data?: unknown
  readonly from: string
  readonly at: number
}

// ResponseDelivered records that one terminal crossed its accepted call link.
export interface ResponseDelivered extends Event {
  readonly epoch?: number
  readonly type: "ResponseDelivered"
  readonly method: string
  readonly call: string
  readonly at: number
}

// AlarmFired records the platform alarm crossing in an actor's private log.
export interface AlarmFired extends Event {
  readonly type: "AlarmFired"
  readonly scheduledFor: number
  readonly at: number
}

// CallTimedOut is the caller terminal produced when an alarm crosses a recorded deadline.
export interface CallTimedOut extends Event {
  readonly reference?: InvocationCoordinate
  readonly epoch?: number
  readonly type: "CallTimedOut"
  readonly call: string
  readonly method: string
  readonly target: string
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

export const InvocationCancellationCause = Schema.Literals(["requested", "deadline"])

export type InvocationCancellationCause = typeof InvocationCancellationCause.Type

// CancellationRequested records a request to stop one actor method invocation epoch.
export const CancellationRequested = Schema.Struct({
  type: Schema.Literal("CancellationRequested"),
  request: Schema.String,
  invocation: InvocationRef,
  cause: InvocationCancellationCause,
  reason: Schema.optional(Schema.String),
  deadlineAt: Schema.optional(Schema.Finite),
  at: Schema.Finite
})

export type CancellationRequested = typeof CancellationRequested.Type

export const CancellationInput = Schema.Struct({
  invocation: InvocationRef,
  reason: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CancellationInput" })

export type CancellationInput = typeof CancellationInput.Type

export const CancellationResult = Schema.Struct({
  cancelled: Schema.Boolean
}).annotate({ identifier: "CancellationResult" })

export type CancellationResult = typeof CancellationResult.Type

export interface CancellationDispatched extends Event {
  readonly reference?: InvocationCoordinate
  readonly type: "CancellationDispatched"
  readonly request: string
  readonly invocation: InvocationRef
  readonly target: string
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

// InvocationCancellation carries one decoded cancellation request to method and component projections.
export interface InvocationCancellation {
  readonly request: string
  readonly invocation: InvocationRef
  readonly cause: InvocationCancellationCause
  readonly reason?: string
  readonly deadlineAt?: number
}
