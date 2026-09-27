import { settledProjection } from "./settled-projection"
import { Atom } from "effect/unstable/reactivity"
import { Conversation, trajectoryState } from "../projections"

export const trajectory = settledProjection({
  schema: Conversation,
  initial: [], reduce: trajectoryState,
}).pipe(Atom.withLabel("trajectory"))
