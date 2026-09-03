import type { Event } from "@clavia/tardigrade-core/event"

/**
 * KeyFragment derives stable event keys for one event alphabet.
 *
 *   KeyFragment
 *     ├── prefixes   namespaces claimed by the fragment
 *     └── keyOf      key derived from an event
 *
 * A package owns its key derivation because it knows which fields identify an occurrence. Duplicate prefixes throw during composition.
 */
export interface KeyFragment {
  readonly prefixes: ReadonlyArray<string>
  readonly keyOf: (e: Event) => string | undefined
}

// composeKeys combines disjoint key fragments into one event-key derivation. Duplicate prefixes throw during construction.
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
