import { Schema } from "effect"
import { act } from "@clavia/tardigrade-core"
import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ToolSpec } from "@clavia/tardigrade-libraries/types"
import { ModelReply, ToolCall, Decision, BudgetDecision, BudgetMetric, PermissionRequest, Conversation } from "./events"

const ModelInput = Schema.Struct({ model: ModelRef, system: Schema.String, tools: Schema.Array(ToolSpec), context: Conversation })
export const Generate = act({
  name: "agent.model.generate",
  input: ModelInput,
  success: ModelReply,
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

// requests retains invocation handles by domain identity; latestOnly releases preceding handles when a new tag arrives (packages/platform/test/bun/input-digest.test.ts).
export function requests<Input extends { readonly tag: string; readonly input: unknown }, Output>(create: (input: Input) => Output, identityOrOptions: ((input: Input) => string) | { readonly latestOnly?: boolean } = input => input.tag) {
  const identity = typeof identityOrOptions === "function" ? identityOrOptions : (input: Input) => input.tag
  const latestOnly = typeof identityOrOptions !== "function" && identityOrOptions.latestOnly
  const cache = new Map<string, Output>()
  return (input: Input): Output => {
    const key = identity(input)
    const existing = cache.get(key)
    if (existing !== undefined) return existing
    const value = create(input)
    if (latestOnly) cache.clear()
    cache.set(key, value)
    return value
  }
}

// failureMessage renders structured act failures at text-only domain boundaries.
export const failureMessage = (reason: Schema.Json): string => typeof reason === "string" ? reason : JSON.stringify(reason)
