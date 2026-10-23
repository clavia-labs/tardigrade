import { Effect, Schema } from "effect"
import { act } from "@clavia/tardigrade-core"
import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ToolSpec } from "@clavia/tardigrade-libraries/types"
import { ModelReply, ToolCall, Decision, BudgetDecision, BudgetMetric, PermissionRequest, Conversation } from "./events"
import { digestInput } from "@clavia/tardigrade-core/runtime/input-digest"
import { LogModelContext, StoredModelContext, PreparedModelContext } from "./model-context"

// OutputContract carries the schema that a provider-native response format must enforce.
export const OutputContract = Schema.Struct({
  name: Schema.NonEmptyString,
  schema: Schema.Json,
  correction: Schema.optionalKey(Schema.Struct({ attempts: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)), projectHistory: Schema.optionalKey(Schema.Boolean) })),
})
export type OutputContract = typeof OutputContract.Type

const ModelInput = Schema.Struct({ model: ModelRef, system: Schema.String, tools: Schema.Array(ToolSpec), context: Conversation, output: Schema.optionalKey(OutputContract) })
export type InlineModelInput = typeof ModelInput.Type
export const Generate = act({
  name: "agent.model.generate",
  input: Schema.Struct({ ...ModelInput.fields, context: Schema.Union([Conversation, StoredModelContext]) }),
  success: ModelReply,
  failure: Schema.String,
})

// generateRequest persists a verified log selection while reusing prepared messages during live execution (platform/test/properties/turn-facts.ts, modelContextRecovery).
export function generateRequest({ logContext, ...options }: Parameters<typeof Generate.request>[0] & { readonly logContext?: LogModelContext }) {
  const full = Generate.request(options)
  if (!logContext || !Array.isArray(options.input.context)) return full
  const input = full.request.input as unknown as InlineModelInput
  const request = Generate.request({ ...options, input: { ...input, context: { ...logContext, expected: digestInput(full.request.input) } } })
  return { ...request, execute: (accepted: Schema.Json) => request.execute(accepted).pipe(Effect.provideService(PreparedModelContext, input.context)) }
}
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

// requests retains handles by domain identity; latestOnly releases preceding handles (packages/platform/test/bun/input-digest.test.ts).
export function requests<Input, Output>(create: (input: Input) => Output, options: { readonly latestOnly?: boolean } = {}) {
  const cache = new Map<string, Output>()
  return (key: string, input: Input): Output => {
    const existing = cache.get(key)
    if (existing !== undefined) return existing
    const value = create(input)
    if (options.latestOnly) cache.clear()
    cache.set(key, value)
    return value
  }
}

// failureMessage renders structured act failures at text-only domain boundaries.
export const failureMessage = (reason: Schema.Json): string => typeof reason === "string" ? reason : JSON.stringify(reason)
