import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ActorRequest, ActorDecision, Resolution, ResolutionRequest } from "@clavia/tardigrade-experimental-host"
import { Schema } from "effect"
import { EffectRef, ExecutionHandle, promiseSchema } from "@clavia/tardigrade-experimental-core"
import { AlarmSet, AlarmCancelled, ToolPromise } from "@clavia/tardigrade-experimental-packages"

export { AlarmSet, AlarmCancelled }

export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Unknown })
export const ModelReply = Schema.Struct({ text: Schema.String, toolCalls: Schema.Array(ToolCall) })
export const ModelPromiseSettled = promiseSchema({ success: ModelReply, error: Schema.String })
export const ModelSubmitted = Schema.Struct({ type: Schema.Literal("ModelSubmitted"), callId: Schema.String, ref: EffectRef, handle: ExecutionHandle })
export const Decision = Schema.Struct({ allowed: Schema.Boolean, reason: Schema.String })

export const PermissionMode = Schema.Literals(["allow", "deny", "ask"])
export const PermissionPolicy = Schema.Struct({ default: PermissionMode, tools: Schema.Record(Schema.String, PermissionMode), readOnly: Schema.optionalKey(PermissionMode) })
export const BudgetPolicy = Schema.Struct({ maxCalls: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), requestTool: Schema.optionalKey(Schema.NonEmptyString) })
export const PermissionConfigured = Schema.Struct({ type: Schema.Literal("PermissionConfigured"), policy: PermissionPolicy })
export const PermissionUpdated = Schema.Struct({ type: Schema.Literal("PermissionUpdated"), policy: PermissionPolicy })
export const BudgetConfigured = Schema.Struct({ type: Schema.Literal("BudgetConfigured"), policy: BudgetPolicy })
export const BudgetUpdated = Schema.Struct({ type: Schema.Literal("BudgetUpdated"), policy: BudgetPolicy })

export const BudgetDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), additionalCalls: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])

export const BudgetRequested = Schema.Struct({ type: Schema.Literal("BudgetRequested"), callId: Schema.String, amount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)), reason: Schema.NonEmptyString })

export const BudgetSubmitted = Schema.Struct({ type: Schema.Literal("BudgetSubmitted"), callId: Schema.String, ...ResolutionRequest.fields })
export const PermissionSubmitted = Schema.Struct({ type: Schema.Literal("PermissionSubmitted"), callId: Schema.String, ...ResolutionRequest.fields })

export const BudgetResolved = Schema.Struct({ type: Schema.Literal("BudgetResolved"), callId: Schema.String, decision: BudgetDecision })
export type BudgetResolved = typeof BudgetResolved.Type

export const PermissionRequested = Schema.Struct({ type: Schema.Literal("PermissionRequested"), callId: Schema.String })
export type PermissionRequested = typeof PermissionRequested.Type

export const PermissionResolved = Schema.Struct({ type: Schema.Literal("PermissionResolved"), callId: Schema.String, decision: Decision })
export type PermissionResolved = typeof PermissionResolved.Type

export const ToolCalled = Schema.Struct({ type: Schema.Literal("ToolCalled"), callId: Schema.String, charged: Schema.Boolean })
export type ToolCalled = typeof ToolCalled.Type

export const ToolReturned = Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String), promise: Schema.optionalKey(ToolPromise) })
export type ToolReturned = typeof ToolReturned.Type

export const MessageReceived = Schema.Union([
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("message"), turnId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("request"), handle: ExecutionHandle, request: ActorRequest }),
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("reply"), handle: ExecutionHandle, requestId: Schema.String, decision: ActorDecision }),
])
export type MessageReceived = typeof MessageReceived.Type

const ModelMetadata = {
  model: ModelRef,
  contextWindowTokens: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
}

export const ModelCalled = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ModelCalled"), purpose: Schema.Literal("inference"), ...ModelMetadata, turnId: Schema.String, callId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ModelCalled"), purpose: Schema.Literal("compaction"), ...ModelMetadata, callId: Schema.String, through: Schema.Finite }),
])
export type ModelCalled = typeof ModelCalled.Type

export const ModelReturned = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("inference"), callId: Schema.String, text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("compaction"), callId: Schema.String, text: Schema.String }),
])
export type ModelReturned = typeof ModelReturned.Type

export const TurnSettled = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literal("completed"), output: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literals(["failed", "cancelled"]), reason: Schema.String }),
])
export type TurnSettled = typeof TurnSettled.Type

export const Event = Schema.Union([
  AlarmSet,
  AlarmCancelled,
  BudgetConfigured,
  BudgetUpdated,
  PermissionConfigured,
  PermissionUpdated,
  BudgetSubmitted,
  PermissionSubmitted,
  BudgetRequested,
  BudgetResolved,
  PermissionRequested,
  PermissionResolved,
  ToolCalled,
  ToolReturned,
  MessageReceived,
  ModelCalled,
  ModelSubmitted,
  Resolution,
  ModelReturned,
  TurnSettled,
])
export type Event = typeof Event.Type

export const message = (input: { readonly text: string; readonly turnId?: string }): MessageReceived =>
  ({ type: "MessageReceived", kind: "message", turnId: input.turnId ?? crypto.randomUUID(), text: input.text })

export const resolveBudget = (callId: string, decision: typeof BudgetDecision.Type): BudgetResolved =>
  ({ type: "BudgetResolved", callId, decision })

export const resolvePermission = (callId: string, decision: typeof Decision.Type): PermissionResolved =>
  ({ type: "PermissionResolved", callId, decision })

export const updatePermission = (policy: typeof PermissionPolicy.Type): typeof PermissionUpdated.Type =>
  ({ type: "PermissionUpdated", policy })

// updateBudget replaces the base allowance while retaining usage and grants from resolved requests.
export const updateBudget = (policy: typeof BudgetPolicy.Type): typeof BudgetUpdated.Type =>
  ({ type: "BudgetUpdated", policy })
