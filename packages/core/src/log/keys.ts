import type { Event } from "@clavia/tardigrade-core/event"

// KeyFragment is one package's key derivation for its own alphabet, its prefixes declared as
// data so composition can prove disjointness. The package owns the derivation because it knows
// which field names an occurrence and what scope the id is unique in. The platform owns the
// minting and composition. The caller never supplies a key because identity derives from intent.
export interface KeyFragment {
  readonly prefixes: ReadonlyArray<string>
  readonly keyOf: (e: Event) => string | undefined
}

// composeKeys folds fragments into one derivation, first answer wins. Two fragments claiming a
// prefix is a construction-time error because the collision would cross-absorb packages' events.
export const composeKeys = (...fragments: ReadonlyArray<KeyFragment>): ((e: Event) => string | undefined) => {
  const claimed = new Map<string, number>()
  fragments.forEach((fragment, i) => {
    for (const prefix of fragment.prefixes) {
      const prior = claimed.get(prefix)
      if (prior !== undefined) {
        throw new Error(`key prefix "${prefix}" claimed by fragments ${prior} and ${i}`)
      }
      claimed.set(prefix, i)
    }
  })
  return (e) => {
    for (const fragment of fragments) {
      const key = fragment.keyOf(e)
      if (key !== undefined) return key
    }
    return undefined
  }
}
