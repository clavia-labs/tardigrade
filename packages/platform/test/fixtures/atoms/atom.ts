import { AtomState } from "@clavia/tardigrade-core"
import { durableAtom, type DurableAtom, type DurableAtomOptions } from "@clavia/tardigrade-core/experimental"

export const checkpointAtomKinds = ["regular", "family"] as const
export type CheckpointAtomKind = typeof checkpointAtomKinds[number]

// checkpointAtom supplies the same reducer contract through regular and keyed constructors.
export function checkpointAtom<State, Event>(kind: CheckpointAtomKind, options: DurableAtomOptions<State, Event>): DurableAtom<State, Event> {
  return kind === "regular" ? durableAtom(options) : durableAtom.family({ ...options, key: () => options.name })(options.name)
}

export const checkpointIdentity = (node: DurableAtom<unknown, unknown>) => node[AtomState].identity!
