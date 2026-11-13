import * as Prompt from "effect/ai/Prompt"
import { promptBoundary } from "@clavia/tardigrade-model/prompt"
import { ResolvedContext, type Conversation } from "./events"
import type { LibraryContext } from "@clavia/tardigrade-libraries"

export type ContextConfiguration = typeof ResolvedContext.Type & { readonly dynamic: boolean }

// contextParts labels each library part while retaining its provider options and declaration order.
export function contextParts(libraries: readonly LibraryContext[]): readonly Prompt.TextPart[] {
  return libraries.flatMap(context => promptBoundary(context.content).map(part => Prompt.makePart("text", {
    text: `<library-context name="${context.library}">\n${part.text}\n</library-context>`, options: part.options,
  })))
}

export const UserContextConfiguration = ResolvedContext.fields.user
export type UserContextConfiguration = typeof UserContextConfiguration.Type

// mergeLibraryContexts overlays resolved slots without discarding recorded libraries.
export function mergeLibraryContexts(statics: readonly LibraryContext[], resolved: readonly LibraryContext[]): readonly LibraryContext[] {
  return [
    ...statics.map(source => resolved.find(value => value.library === source.library) ?? source),
    ...resolved.filter(value => !statics.some(source => source.library === value.library)),
  ]
}

// isUserContextSuffix identifies adjacent rows rendered as a single user message (platform/test/bun/agent-content.test.ts).
export function isUserContextSuffix(message: typeof Conversation.Type[number], previous: typeof Conversation.Type[number] | undefined): boolean {
  return message.role === "user" && "context" in message && message.context === true && previous?.role === "user"
    && previous.turnId === message.turnId && !("context" in previous && previous.context)
}
