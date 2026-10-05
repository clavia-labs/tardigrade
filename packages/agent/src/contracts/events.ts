import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ResolutionSettled as PromiseSettled, event, type DeclaredEvent, ActorRequest, AbortRequested, InvocationRef, ExecutionHandle, EffectRef } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { ObjectRef } from "@clavia/tardigrade-model/object/reference"

const ProviderToolCall = Schema.Struct({ callId: Schema.String, name: Schema.String, input: Schema.Json })
export const ToolCall = Schema.Struct({ ...ProviderToolCall.fields, providerId: Schema.String })
const TokenCount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const ModelUsage = Schema.Struct({
  input: Schema.optionalKey(TokenCount), output: Schema.optionalKey(TokenCount),
  usd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
})
export const ProviderContinuation = Schema.Struct({
  provider: Schema.String, protocol: Schema.String, model: Schema.String,
  payload: Schema.Json,
})
export type ProviderContinuation = typeof ProviderContinuation.Type
const ModelReasoning = {
  reasoning: Schema.optionalKey(Schema.String),
  continuation: Schema.optionalKey(ProviderContinuation),
}
export const ModelReply = Schema.Struct({ ...ModelReasoning, text: Schema.String, toolCalls: Schema.Array(ProviderToolCall), usage: Schema.optionalKey(ModelUsage), outputErrors: Schema.optionalKey(Schema.Array(Schema.String)) })
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

export const ToolCalled = Schema.Struct({ type: Schema.Literal("ToolCalled"), callId: Schema.String, codeMode: Schema.optionalKey(Schema.NonEmptyString), counted: Schema.Boolean })
export type ToolCalled = typeof ToolCalled.Type

export const ToolReturned = Schema.Struct({ type: Schema.Literal("ToolReturned"), callId: Schema.String, output: Schema.String, error: Schema.NullOr(Schema.String), promise: Schema.optionalKey(ToolPromise) })
export type ToolReturned = typeof ToolReturned.Type

export const TurnRequested = event({
  type: "TurnRequested", turnId: Schema.String, text: Schema.String,
  content: Schema.optionalKey(Schema.Array(Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("file"), mediaType: Schema.NonEmptyString, filename: Schema.optionalKey(Schema.String), object: ObjectRef }),
  ]))),
  invocationRef: Schema.optionalKey(InvocationRef),
  source: Schema.optionalKey(Schema.Literals(["user", "agent", "tool"])),
  promiseRef: Schema.optionalKey(EffectRef), outcome: Schema.optionalKey(Schema.Literals(["completed", "failed", "cancelled"])),
})
export type TurnRequested = typeof TurnRequested.Type

export const ActorRequestReceived = Schema.Struct({ type: Schema.Literal("ActorRequestReceived"), handle: ExecutionHandle, request: ActorRequest })
export const ActorReplyReceived = Schema.Struct({ type: Schema.Literal("ActorReplyReceived"), handle: ExecutionHandle, requestId: Schema.String, result: Schema.Json })

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
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("inference"), callId: Schema.String, ...ModelReasoning, text: Schema.String, toolCalls: Schema.Array(ToolCall), usage: Schema.optionalKey(ModelUsage) }),
  Schema.Struct({ type: Schema.Literal("ModelReturned"), purpose: Schema.Literal("compaction"), callId: Schema.String, ...ModelReasoning, text: Schema.String, usage: Schema.optionalKey(ModelUsage) }),
])
export type ModelReturned = typeof ModelReturned.Type

export const CompactionFailed = Schema.Struct({ type: Schema.Literal("CompactionFailed"), callId: Schema.String, reason: Schema.String })
export const ModelFailed = Schema.Struct({ type: Schema.Literal("ModelFailed"), callId: Schema.String, reason: Schema.String })
export const OutputRejected = Schema.Struct({
  type: Schema.Literal("OutputRejected"), turnId: Schema.String, callId: Schema.String,
  contract: Schema.String, text: Schema.String, errors: Schema.Array(Schema.String),
  attempt: Schema.Finite, maxCorrections: Schema.Finite,
})
export { AbortRequested } from "@clavia/tardigrade-core"

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
  TurnRequested,
  ActorRequestReceived,
  ActorReplyReceived,
  ModelCalled,
  ModelFailed,
  OutputRejected,
  AbortRequested,
  CompactionFailed,
  PromiseSettled,
  ModelReturned,
  TurnSettled,
])
export type Event = typeof Event.Type

// requestTurn proposes inference independently of the actor's public method names.
export const requestTurn = (input: { readonly text: string; readonly turnId?: string; readonly invocationRef?: InvocationRef }): DeclaredEvent<TurnRequested> => {
  const turnId = input.turnId ?? crypto.randomUUID()
  return TurnRequested.make({ source: "user", ...input, turnId })
}

export const resolveBudget = (metric: string, callId: string, decision: typeof BudgetDecision.Type): BudgetResolved =>
  ({ type: "BudgetResolved", metric, callId, decision })

export const resolvePermission = (action: string, requestId: string, decision: typeof Decision.Type): PermissionResolved =>
  ({ type: "PermissionResolved", action, requestId, decision })

export const updatePermission = (policy: typeof PermissionPolicy.Type): typeof PermissionUpdated.Type =>
  ({ type: "PermissionUpdated", policy })

// updateBudget replaces the base allowance while retaining usage and grants from resolved requests.
export const updateBudget = (metric: string, policy: typeof BudgetPolicy.Type): typeof BudgetUpdated.Type =>
  ({ type: "BudgetUpdated", metric, policy })

// turnSource identifies the origin of inference input.
export function turnSource(event: TurnRequested): "user" | "agent" | "tool" {
  return event.source ?? "user"
}

export const MessageContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file"), mediaType: Schema.NonEmptyString, filename: Schema.optionalKey(Schema.String), object: ObjectRef }),
])
export type MessageContentPart = typeof MessageContentPart.Type
export const MessageContent = Schema.Array(MessageContentPart)
export type MessageContent = typeof MessageContent.Type

const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: MessageContent }),
  Schema.Struct({ role: Schema.Literal("assistant"), ...ModelReasoning, text: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.Struct({ role: Schema.Literal("tool"), callId: Schema.String, providerId: Schema.String, name: Schema.String, text: Schema.String, error: Schema.Boolean }),
])
export const Conversation = Schema.Array(Message)
export const Trajectory = Schema.Array(Schema.Struct({ turnId: Schema.String, message: Message }))
