import { Schema } from "effect"
import { MessageReceived, ModelReturned, ToolReturned } from "../../event"
import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Atom } from "effect/unstable/reactivity"
import { Conversation, trajectoryState } from "../../projections"

const source = durableAtom({ name: "agent.trajectory", input: Schema.Union([MessageReceived, ModelReturned, ToolReturned]),
  schema: Conversation,
  initial: [], reduce: trajectoryState,
})

export const trajectory = Object.assign(source, { label: Atom.withLabel(source, "trajectory").label! })
