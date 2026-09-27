import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Atom } from "effect/unstable/reactivity"
import { Conversation, trajectoryState } from "../projections"

export const trajectory = durableAtom({
  schema: Conversation,
  initial: [], reduce: trajectoryState,
}).pipe(Atom.withLabel("trajectory"))
