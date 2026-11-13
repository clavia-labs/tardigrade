import { Schema } from "effect"
import * as Prompt from "effect/ai/Prompt"

export const PromptContent = Schema.Union([Schema.String, Schema.Array(Prompt.TextPart)])
export type PromptContent = typeof PromptContent.Type

// promptParts expands string shorthand while retaining explicit text parts and their options.
export function promptParts(content: PromptContent | undefined): readonly Prompt.TextPart[] {
  return typeof content === "string" ? [Prompt.makePart("text", { text: content })] : content ?? []
}

// systemMessages maps each text part to a system message with the same provider options.
export function systemMessages(content: PromptContent | undefined): readonly Prompt.SystemMessage[] {
  return promptParts(content).map(part => Prompt.makeMessage("system", { content: part.text, options: part.options }))
}

const boundaryKey = "tardie/prompt-boundary"

// promptBoundary marks a source group for checkpoint placement, omitting blank string shorthand.
export function promptBoundary(content: PromptContent | undefined): readonly Prompt.TextPart[] {
  if (typeof content === "string" && !content.trim()) return []
  const parts = promptParts(content)
  return parts.map((part, index) => index === parts.length - 1
    ? Prompt.makePart("text", { text: part.text, options: { ...part.options, [boundaryKey]: true } }) : part)
}

export function isPromptBoundary(options: Prompt.ProviderOptions): boolean {
  return options[boundaryKey] === true
}
