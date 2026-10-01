import { Schema } from "effect"
import { MessageReceived, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled } from "../../event"
import { atom, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Atom } from "effect/unstable/reactivity"
import { TrajectoryState, trajectoryState } from "../../projections"

const source = durableAtom({ name: "agent.trajectory", input: Schema.Union([MessageReceived, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled]),
  schema: TrajectoryState,
  initial: { entries: [], models: [] }, reduce: trajectoryState,
})

// trajectory preserves message order and turn ownership, including pending model attribution across recovery.
export const trajectory = atom(get => get(source).entries).pipe(Atom.withLabel("trajectory"))
// conversation projects trajectory messages for model input without turn metadata.
export const conversation = atom(get => get(trajectory).map(entry => entry.message))
