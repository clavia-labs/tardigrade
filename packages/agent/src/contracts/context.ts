import type { Conversation } from "./events"
import { Schema } from "effect"
import type { LibraryContextContribution } from "@clavia/tardigrade-libraries"

export interface ContextConfiguration {
  readonly system: string | undefined
  readonly dynamic: boolean
  readonly contributions: readonly LibraryContextContribution[]
}

// contextText labels library contributions while retaining declaration order.
export function contextText(contributions: readonly LibraryContextContribution[], slot: "system" | "user"): string {
  return contributions.flatMap(contribution => {
    const text = contribution[slot]
    return text?.trim() ? [`<library-context name="${contribution.library}">\n${text}\n</library-context>`] : []
  }).join("\n\n")
}

export const UserContextConfiguration = Schema.Struct({
  contributions: Schema.Array(Schema.Struct({ library: Schema.String, user: Schema.optionalKey(Schema.String) })),
})
export type UserContextConfiguration = typeof UserContextConfiguration.Type

// mergeContextContributions overlays resolved slots without discarding recorded libraries.
export function mergeContextContributions(statics: readonly LibraryContextContribution[], resolved: readonly LibraryContextContribution[]): readonly LibraryContextContribution[] {
  return [
    ...statics.map(source => ({ ...source, ...resolved.find(value => value.library === source.library) })),
    ...resolved.filter(value => !statics.some(source => source.library === value.library)),
  ]
}

// isUserContextSuffix identifies adjacent rows rendered as a single user message (platform/test/bun/agent-content.test.ts).
export function isUserContextSuffix(message: typeof Conversation.Type[number], previous: typeof Conversation.Type[number] | undefined): message is Extract<typeof Conversation.Type[number], { readonly role: "user"; readonly text: string }> {
  return message.role === "user" && "context" in message && message.context === true && previous?.role === "user"
    && previous.turnId === message.turnId && !("context" in previous && previous.context)
}
