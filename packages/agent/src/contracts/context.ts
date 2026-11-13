import type { Conversation } from "./events"
import { Schema } from "effect"
import type { LibraryContext } from "@clavia/tardigrade-libraries"

export interface ContextConfiguration {
  readonly system: string | undefined
  readonly dynamic: boolean
  readonly libraries: readonly LibraryContext[]
}

// contextText labels library context while retaining declaration order.
export function contextText(libraries: readonly LibraryContext[], slot: "system" | "user"): string {
  return libraries.flatMap(context => {
    const text = context[slot]
    return text?.trim() ? [`<library-context name="${context.library}">\n${text}\n</library-context>`] : []
  }).join("\n\n")
}

export const UserContextConfiguration = Schema.Struct({
  libraries: Schema.Array(Schema.Struct({ library: Schema.String, user: Schema.optionalKey(Schema.String) })),
})
export type UserContextConfiguration = typeof UserContextConfiguration.Type

// mergeLibraryContexts overlays resolved slots without discarding recorded libraries.
export function mergeLibraryContexts(statics: readonly LibraryContext[], resolved: readonly LibraryContext[]): readonly LibraryContext[] {
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
