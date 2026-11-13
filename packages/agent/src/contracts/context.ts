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
