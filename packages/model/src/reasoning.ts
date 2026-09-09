import type { OpenAITextProviderOptions } from "@tanstack/ai-openai"
import type { AnthropicTextProviderOptions, AnthropicChatModelProviderOptionsByName } from "@tanstack/ai-anthropic"
import type { ModelProtocol } from "./directory"

// ThinkingConfig uses the model map because TanStack's broad options intersect adaptive thinking with the legacy modes (reasoning.test.ts).
export type ThinkingConfig = NonNullable<
  AnthropicChatModelProviderOptionsByName[keyof AnthropicChatModelProviderOptionsByName]["thinking"]
>

type OpenAIEffort = NonNullable<OpenAITextProviderOptions["reasoning"]>["effort"]

export interface ModelOptionsByProtocol {
  readonly "anthropic-messages": {
    readonly thinking?: ThinkingConfig
    readonly output_config?: AnthropicTextProviderOptions["output_config"]
    readonly reasoning?: never
    readonly reasoning_effort?: never
  }
  readonly "openai-responses": {
    readonly reasoning?: Pick<NonNullable<OpenAITextProviderOptions["reasoning"]>, "effort">
    readonly thinking?: never
    readonly output_config?: never
    readonly reasoning_effort?: never
  }
  readonly "openai-chat-completions": {
    readonly reasoning_effort?: OpenAIEffort
    readonly reasoning?: never
    readonly thinking?: never
    readonly output_config?: never
  }
  readonly "bedrock-converse": never
}

// ProtocolOptions ties native request options to their wire (reasoning.types.test.ts).
export type ProtocolOptions = {
  [P in ModelProtocol]: { readonly protocol: P; readonly options?: ModelOptionsByProtocol[P] }
}[ModelProtocol] | { readonly protocol: ModelProtocol; readonly options?: never }

const fieldsOf = (value: unknown, fields: readonly string[], label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const source = value as Record<string, unknown>
  const unknown = Object.keys(source).filter((key) => !fields.includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`)
  return source
}

const effortOf = <const T extends readonly (string | null)[]>(value: unknown, allowed: T): T[number] => {
  if (!allowed.some((entry) => entry === value)) throw new Error("options effort is unsupported for this protocol")
  return value as T[number]
}

const openAIEffortOf = (value: unknown) => effortOf(value, ["none", "minimal", "low", "medium", "high"] as const)

const thinkingOf = (value: unknown): ThinkingConfig => {
  const raw = fieldsOf(value, ["type", "budget_tokens", "display"], "options.thinking")
  switch (raw.type) {
    case "enabled": {
      fieldsOf(raw, ["type", "budget_tokens"], "options.thinking")
      if (typeof raw.budget_tokens !== "number" || !Number.isSafeInteger(raw.budget_tokens) || raw.budget_tokens <= 0) throw new Error("options.thinking.budget_tokens must be a positive safe integer")
      return { type: raw.type, budget_tokens: raw.budget_tokens }
    }
    case "adaptive": {
      fieldsOf(raw, ["type", "display"], "options.thinking")
      if (raw.display !== undefined && raw.display !== "summarized" && raw.display !== "omitted") throw new Error("options.thinking.display must be summarized or omitted")
      return { type: raw.type, ...(raw.display === undefined ? {} : { display: raw.display }) }
    }
    case "disabled":
      fieldsOf(raw, ["type"], "options.thinking")
      return { type: raw.type }
    default: throw new Error("options.thinking.type must be adaptive, enabled, or disabled")
  }
}

// protocolOptionsOf validates external request options and preserves their protocol discriminant (reasoning.test.ts).
export const protocolOptionsOf = (protocol: ModelProtocol, value: unknown): ProtocolOptions => {
  if (value === undefined) return { protocol }
  switch (protocol) {
    case "anthropic-messages": {
      const source = fieldsOf(value, ["thinking", "output_config"], "options")
      const output = source.output_config === undefined ? undefined : fieldsOf(source.output_config, ["effort"], "options.output_config")
      return { protocol, options: {
        ...(source.thinking === undefined ? {} : { thinking: thinkingOf(source.thinking) }),
        ...(output === undefined ? {} : { output_config: output.effort === undefined ? {} : { effort: effortOf(output.effort, ["low", "medium", "high", "xhigh", "max", null] as const) } })
      } }
    }
    case "openai-responses": {
      const source = fieldsOf(value, ["reasoning"], "options")
      const reasoning = source.reasoning === undefined ? undefined : fieldsOf(source.reasoning, ["effort"], "options.reasoning")
      return { protocol, options: reasoning === undefined ? {} : { reasoning: reasoning.effort === undefined ? {} : { effort: openAIEffortOf(reasoning.effort) } } }
    }
    case "openai-chat-completions": {
      const source = fieldsOf(value, ["reasoning_effort"], "options")
      return { protocol, options: source.reasoning_effort === undefined ? {} : { reasoning_effort: openAIEffortOf(source.reasoning_effort) } }
    }
    case "bedrock-converse": throw new Error("request options are not supported for bedrock-converse")
  }
}
