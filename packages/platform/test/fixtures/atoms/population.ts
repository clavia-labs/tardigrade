import { Schema } from "effect"
import { event, type Recorded } from "@clavia/tardigrade-core"
import { durableAtom } from "@clavia/tardigrade-core/experimental"
import { checkpointAtom, checkpointIdentity, type CheckpointAtomKind } from "./atom"

export const atomPopulationKinds = ["regular", "family", "mixed"] as const
export type AtomPopulationKind = typeof atomPopulationKinds[number]
export const atomPopulationKeys = ["rick", "morty", "summer"] as const
export const Changed = event({ type: "Changed", id: Schema.String, amount: Schema.Int })
export type Changed = typeof Changed.Type

// atomPopulation supplies identities, routed counters, and a full-replay oracle independently of checkpoint storage.
export function atomPopulation(kind: AtomPopulationKind, name: string, options: { readonly idleTTL?: number } = {}) {
  const reductions = new Map<string, number>()
  const reduce = (key: string, state: number, amount: number) => {
    reductions.set(key, (reductions.get(key) ?? 0) + 1)
    return state * 2 + amount
  }
  const family = durableAtom.family({ name: `${name}.members`, input: Changed, schema: Schema.Int, initial: 0,
    ...(options.idleTTL === undefined ? {} : { idleTTL: options.idleTTL }),
    key: event => event.id, reduce: (state, event) => reduce(event.id, state, event.amount),
  })
  const members = atomPopulationKeys.map((key, index) => {
    const memberKind: CheckpointAtomKind = kind === "mixed" ? index === 0 ? "regular" : "family" : kind
    const node = memberKind === "family" ? family(key) : checkpointAtom("regular", {
      name: `${name}.${key}`, input: Changed, schema: Schema.Int, initial: 0,
      reduce: (state, event) => event.id === key ? reduce(key, state, event.amount) : state,
    })
    return { key, kind: memberKind, node, identity: checkpointIdentity(node), get reductions() { return reductions.get(key) ?? 0 } }
  })
  const expected = (key: string, records: readonly Recorded<Changed>[], position = records.length) => {
    let value = 0
    for (let index = 0; index < position; index++) {
      const event = records[index]!.event
      if (event.type === "Changed" && event.id === key) value = 2 * value + event.amount
    }
    return value
  }
  return { members, expected, resetReductions: () => reductions.clear() }
}
