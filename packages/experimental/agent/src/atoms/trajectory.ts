import { Schema } from "effect"
import { MessageReceived, ModelReturned, ToolReturned } from "../event"
import { settledProjection } from "./settled-projection"
import { Atom } from "effect/unstable/reactivity"
import { Conversation, trajectoryState } from "../projections"

export const trajectory = settledProjection({ input: Schema.Union([MessageReceived, ModelReturned, ToolReturned]),
  schema: Conversation,
  initial: [], reduce: trajectoryState,
}).pipe(Atom.withLabel("trajectory"))
