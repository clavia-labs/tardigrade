import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ActorRequest, ActorDecision, PromiseSettled, ResolutionRequest } from "@clavia/tardigrade-experimental-host"
import { Schema } from "effect"
import { ExecutionHandle, promiseSchema } from "@clavia/tardigrade-experimental-core"
import { ToolPromise } from "@clavia/tardigrade-experimental-packages"

export const ToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Unknown })
export const ModelReply = Schema.Struct({ text: Schema.String, toolCalls: Schema.Array(ToolCall) })
export const ModelPromiseSettled = promiseSchema({ success: ModelReply, error: Schema.String })
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

export const BudgetPromiseResolved = Schema.Struct({ type: Schema.Literal("BudgetResolved"), callId: Schema.String, promise: ResolutionRequest })
export const PermissionPromiseResolved = Schema.Struct({ type: Schema.Literal("PermissionResolved"), callId: Schema.String, promise: ResolutionRequest })
export const BudgetResolved = Schema.Union([BudgetPromiseResolved, Schema.Struct({ type: Schema.Literal("BudgetResolved"), callId: Schema.String, decision: BudgetDecision })])
export type BudgetResolved = typeof BudgetResolved.Type
export const PermissionResolved = Schema.Union([PermissionPromiseResolved, Schema.Struct({ type: Schema.Literal("PermissionResolved"), callId: Schema.String, decision: Decision })])
export type PermissionResolved = typeof PermissionResolved.Type

export const ToolCalled = Schema.Struct({ type: Schema.Literal("ToolCalled"), callId: Schema.String, charged: Schema.Boolean })
export type ToolCalled = typeof ToolCalled.Type

export const ToolReturned = Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String), promise: Schema.optionalKey(ToolPromise) })
export type ToolReturned = typeof ToolReturned.Type

export const MessageReceived = Schema.Union([
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("message"), source: Schema.optionalKey(Schema.Literals(["user", "agent", "tool"])), turnId: Schema.String, text: Schema.String }),
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

export const ModelPromiseReturned = Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literals(["inference", "compaction"]), callId: Schema.String, promise: ToolPromise })
export const ModelReturned = Schema.Union([
  ModelPromiseReturned,
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("inference"), callId: Schema.String, text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("compaction"), callId: Schema.String, text: Schema.String }),
])
export type ModelReturned = typeof ModelReturned.Type

export const TurnSettled = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literal("completed"), callId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literal("completed"), output: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TurnSettled"), turnId: Schema.String, outcome: Schema.Literals(["failed", "cancelled"]), reason: Schema.String }),
])
export type TurnSettled = typeof TurnSettled.Type

export const Event = Schema.Union([
  BudgetConfigured,
  BudgetUpdated,
  PermissionConfigured,
  PermissionUpdated,
  BudgetResolved,
  PermissionResolved,
  ToolCalled,
  ToolReturned,
  MessageReceived,
  ModelCalled,
  PromiseSettled,
  ModelReturned,
  TurnSettled,
])
export type Event = typeof Event.Type

export const message = (input: { readonly text: string; readonly turnId?: string }): MessageReceived =>
  ({ type: "MessageReceived", kind: "message", source: "user", turnId: input.turnId ?? crypto.randomUUID(), text: input.text })

export const resolveBudget = (callId: string, decision: typeof BudgetDecision.Type): BudgetResolved =>
  ({ type: "BudgetResolved", callId, decision })

export const resolvePermission = (callId: string, decision: typeof Decision.Type): PermissionResolved =>
  ({ type: "PermissionResolved", callId, decision })

export const updatePermission = (policy: typeof PermissionPolicy.Type): typeof PermissionUpdated.Type =>
  ({ type: "PermissionUpdated", policy })

// updateBudget replaces the base allowance while retaining usage and grants from resolved requests.
export const updateBudget = (policy: typeof BudgetPolicy.Type): typeof BudgetUpdated.Type =>
  ({ type: "BudgetUpdated", policy })

// messageSource identifies inbox senders, including synthetic turn identifiers in historical events.
export function messageSource(event: MessageReceived): "user" | "agent" | "tool" {
  if (event.kind !== "message") return "agent"
  if (event.source) return event.source
  if (event.turnId.startsWith("promise:")) {
    const prefix = "Tool promise result (data): "
    if (event.text.startsWith(prefix)) {
      try {
        const value: unknown = JSON.parse(event.text.slice(prefix.length))
        if (Schema.is(Schema.Struct({ handle: Schema.Struct({ executor: Schema.Literal("actor") }) }))(value)) return "agent"
      } catch { return "tool" }
    }
    return "tool"
  }
  return event.turnId.includes(":notice:") ? "agent" : "user"
}
