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

// keysFor derives keys for an allowlist of event types under one prefix.
export const keysFor = (
  prefix: string,
  by: Readonly<Record<string, (event: Event) => string | undefined>>
): KeyFragment => ({
  prefixes: [prefix],
  keyOf: (event) => {
    const suffix = by[event.type]?.(event)
    return suffix === undefined ? undefined : `${prefix}${suffix}`
  }
})

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
