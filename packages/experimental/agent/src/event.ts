import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ActorRequest, ActorDecision, PromiseSettled } from "@clavia/tardigrade-experimental-host/contracts"
import { Schema } from "effect"
import { AbortReceived, ExecutionHandle, EffectRef } from "@clavia/tardigrade-experimental-core"
import { ToolPromise } from "@clavia/tardigrade-experimental-packages/types"

const ProviderToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Json })
export const ToolCall = Schema.Struct({ ...ProviderToolCall.fields, providerId: Schema.String })
const TokenCount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const ModelUsage = Schema.Struct({
  input: Schema.optionalKey(TokenCount), output: Schema.optionalKey(TokenCount),
  usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
export const ModelReply = Schema.Struct({ text: Schema.String, toolCalls: Schema.Array(ProviderToolCall), usage: Schema.optionalKey(ModelUsage) })
export const Decision = Schema.Struct({ allowed: Schema.Boolean, reason: Schema.String })

export const PermissionMode = Schema.Literals(["allow", "deny", "ask"])
export const PermissionAction = Schema.NonEmptyString
export const PermissionRule = Schema.Struct({
  default: Schema.optionalKey(PermissionMode), resources: Schema.Record(Schema.String, PermissionMode),
  readOnly: Schema.optionalKey(PermissionMode),
})
export const PermissionPolicy = Schema.Struct({ default: PermissionMode, actions: Schema.Record(PermissionAction, PermissionRule) })
export const PermissionRequest = Schema.Struct({
  action: PermissionAction, requestId: Schema.NonEmptyString, resource: Schema.NonEmptyString, input: Schema.Json,
  metadata: Schema.optionalKey(Schema.Struct({ readOnly: Schema.optionalKey(Schema.Boolean) })),
})
// BudgetMetric names a measured quantity and its unit, such as toolCalls, usd, or elapsedMs.
export const BudgetMetric = Schema.NonEmptyString
export const BudgetPolicy = Schema.Struct({ limit: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), requestTool: Schema.optionalKey(Schema.NonEmptyString), onExhausted: Schema.optionalKey(Schema.Literals(["wait", "deny"])) })
export const PermissionConfigured = Schema.Struct({ type: Schema.Literal("PermissionConfigured"), policy: PermissionPolicy })
export const PermissionUpdated = Schema.Struct({ type: Schema.Literal("PermissionUpdated"), policy: PermissionPolicy })
export const BudgetConfigured = Schema.Struct({ type: Schema.Literal("BudgetConfigured"), metric: BudgetMetric, policy: BudgetPolicy })
export const BudgetUpdated = Schema.Struct({ type: Schema.Literal("BudgetUpdated"), metric: BudgetMetric, policy: BudgetPolicy })

export const BudgetDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), additional: Schema.Finite.check(Schema.isGreaterThan(0)) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])

export const BudgetResolved = Schema.Struct({ type: Schema.Literal("BudgetResolved"), metric: BudgetMetric, callId: Schema.String, decision: BudgetDecision })
export type BudgetResolved = typeof BudgetResolved.Type
export const PermissionResolved = Schema.Struct({ type: Schema.Literal("PermissionResolved"), action: PermissionAction, requestId: Schema.NonEmptyString, decision: Decision })
export type PermissionResolved = typeof PermissionResolved.Type

export const ToolCalled = Schema.Struct({ type: Schema.Literal("ToolCalled"), callId: Schema.String, counted: Schema.Boolean })
export type ToolCalled = typeof ToolCalled.Type

export const ToolReturned = Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String), promise: Schema.optionalKey(ToolPromise) })
export type ToolReturned = typeof ToolReturned.Type

export const MessageReceived = Schema.Union([
  Schema.Struct({ type: Schema.Literal("MessageReceived"), kind: Schema.Literal("message"), source: Schema.optionalKey(Schema.Literals(["user", "agent", "tool"])), promiseRef: Schema.optionalKey(EffectRef), turnId: Schema.String, text: Schema.String }),
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
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("inference"), callId: Schema.String, text: Schema.String, toolCalls: Schema.Array(ToolCall), usage: Schema.optionalKey(ModelUsage) }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("compaction"), callId: Schema.String, text: Schema.String, usage: Schema.optionalKey(ModelUsage) }),
])
export type ModelReturned = typeof ModelReturned.Type

export const CompactionFailed = Schema.Struct({ type: Schema.Literal("CompactionFailed"), callId: Schema.String, reason: Schema.String })
export const ModelFailed = Schema.Struct({ type: Schema.Literal("ModelFailed"), callId: Schema.String, reason: Schema.String })
export { AbortReceived } from "@clavia/tardigrade-experimental-core"

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
  ModelFailed,
  AbortReceived,
  CompactionFailed,
  PromiseSettled,
  ModelReturned,
  TurnSettled,
])
export type Event = typeof Event.Type

export const message = (input: { readonly text: string; readonly turnId?: string }): MessageReceived =>
  ({ type: "MessageReceived", kind: "message", source: "user", turnId: input.turnId ?? crypto.randomUUID(), text: input.text })

// cancel requests cancellation of the turn active when the event is committed.
export const cancel = (reason: string): AbortReceived => ({ type: "AbortReceived", reason })

export const resolveBudget = (metric: string, callId: string, decision: typeof BudgetDecision.Type): BudgetResolved =>
  ({ type: "BudgetResolved", metric, callId, decision })

export const resolvePermission = (action: string, requestId: string, decision: typeof Decision.Type): PermissionResolved =>
  ({ type: "PermissionResolved", action, requestId, decision })

export const updatePermission = (policy: typeof PermissionPolicy.Type): typeof PermissionUpdated.Type =>
  ({ type: "PermissionUpdated", policy })

// updateBudget replaces the base allowance while retaining usage and grants from resolved requests.
export const updateBudget = (metric: string, policy: typeof BudgetPolicy.Type): typeof BudgetUpdated.Type =>
  ({ type: "BudgetUpdated", metric, policy })

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
