import { Schema } from "effect"
import { act } from "@clavia/tardigrade-core"
import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ToolSpec } from "@clavia/tardigrade-libraries/types"
import { ModelReply, ToolCall, Decision, BudgetDecision, BudgetMetric, PermissionRequest, Conversation } from "./events"

const ModelInput = Schema.Struct({ model: ModelRef, system: Schema.String, tools: Schema.Array(ToolSpec), context: Conversation })
export const ModelFailure = Schema.Struct({ message: Schema.String, retryable: Schema.Boolean, retry: Schema.optionalKey(Schema.Struct({ delayMs: Schema.Finite, dueAt: Schema.Finite })) })
export type ModelFailure = typeof ModelFailure.Type
export const Generate = act({
  name: "agent.model.generate",
  input: Schema.Struct({ ...ModelInput.fields, retryIndex: Schema.optionalKey(Schema.Int) }),
  success: ModelReply,
  failure: Schema.Union([Schema.String, ModelFailure]),
})
export const RetryWait = act({
  name: "agent.model.retry.wait",
  input: Schema.Struct({ at: Schema.Finite }),
  success: Schema.Struct({ at: Schema.Finite }),
  failure: Schema.String,
})
export const Summarize = act({ name: "agent.model.summarize", input: ModelInput, success: ModelReply, failure: Schema.String })
export const AskPermission = act({
  name: "agent.permission.request",
  input: PermissionRequest,
  success: Decision, failure: Schema.String,
})
export const AskBudget = act({
  name: "agent.budget.request",
  input: Schema.Struct({ metric: BudgetMetric, callId: Schema.String, amount: Schema.Finite, reason: Schema.String, used: Schema.Finite, limit: Schema.Finite }),
  success: BudgetDecision, failure: Schema.String,
})
export const ExecuteTool = act({
  name: "agent.tool.execute",
  input: Schema.Struct({ call: ToolCall, counted: Schema.Boolean, value: Schema.optionalKey(Schema.Json), error: Schema.optionalKey(Schema.String) }),
  success: Schema.Json, failure: Schema.String,
})

// requests retains invocation handles by domain identity across reevaluation and replay.
export function requests<Input extends { readonly tag: string; readonly input: unknown }, Output>(create: (input: Input) => Output, identity: (input: Input) => string = input => input.tag) {
  const cache = new Map<string, Output>()
  return (input: Input): Output => {
    const key = identity(input)
    const existing = cache.get(key)
    if (existing !== undefined) return existing
    const value = create(input)
    cache.set(key, value)
    return value
  }
}

// failureMessage renders structured act failures at text-only domain boundaries.
export const failureMessage = (reason: Schema.Json): string => typeof reason === "string" ? reason : JSON.stringify(reason)
