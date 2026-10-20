import { Trajectory, TurnRequested, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled, type Event } from "../../contracts/events"
import { Schema } from "effect"
import { atom, durableAtom } from "@clavia/tardigrade-core"
import { Atom } from "effect/unstable/reactivity"

export const TrajectoryState = Schema.Struct({
  entries: Trajectory,
  models: Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String })),
})
export const TrajectoryEvent = Schema.Union([TurnRequested, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled])
type Entry = typeof Trajectory.Type[number]
type Models = typeof TrajectoryState.Type["models"]

export function findTrajectoryTool(length: number, read: (index: number) => Entry, callId: string) {
  for (let index = length - 1; index >= 0; index--) {
    const entry = read(index)
    const call = entry.message.role === "assistant" ? entry.message.toolCalls.find(call => call.callId === callId) : undefined
    if (call) return { turnId: entry.turnId, call }
  }
  return undefined
}

export function trajectoryChange(event: Event, models: Models, findTool: (callId: string) => ReturnType<typeof findTrajectoryTool>): { readonly entry?: Entry; readonly models?: Models } {
  if (event.type === "TurnRequested") return { entry: { turnId: event.turnId, message: event.content === undefined ? { role: "user", text: event.text } : { role: "user", content: event.content } } }
  if (event.type === "ModelCalled" && event.purpose === "inference") return { models: [...models, { callId: event.callId, turnId: event.turnId }] }
  if (event.type === "ModelReturned" && event.purpose === "inference") {
    const call = models.find(call => call.callId === event.callId)
    if (call) return {
      entry: { turnId: call.turnId, message: { role: "assistant", text: event.text, toolCalls: event.toolCalls, ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }), ...(event.continuation === undefined ? {} : { continuation: event.continuation }) } },
      models: models.filter(value => value !== call),
    }
  }
  if (event.type === "ToolReturned") {
    const found = findTool(event.callId)
    const text = event.error ?? event.content.filter(part => part.type === "text").map(part => part.text).join("\n")
    const media = event.error === null && event.content.some(part => part.type === "file")
    if (found) return { entry: { turnId: found.turnId, message: { role: "tool", callId: event.callId, providerId: found.call.providerId, name: found.call.name, text, ...(media ? { content: event.content } : {}), error: event.error !== null } } }
  }
  if (event.type === "ModelFailed") return { models: models.filter(call => call.callId !== event.callId) }
  if (event.type === "TurnSettled") return { models: models.filter(call => call.turnId !== event.turnId) }
  return {}
}

export function reduceTrajectory(state: typeof TrajectoryState.Type, event: Event): typeof TrajectoryState.Type {
  const change = trajectoryChange(event, state.models, callId => findTrajectoryTool(state.entries.length, index => state.entries[index]!, callId))
  return change.entry || change.models ? { entries: change.entry ? [...state.entries, change.entry] : state.entries, models: change.models ?? state.models } : state
}

export const trajectoryState = durableAtom({ name: "agent.trajectory", input: TrajectoryEvent, schema: TrajectoryState, initial: { entries: [], models: [] },
  edit: (state, event) => {
    const change = trajectoryChange(event, state.read(["models"]), callId => findTrajectoryTool(state.length(["entries"]), index => state.read(["entries", index]), callId))
    if (change.entry) state.append(["entries"], [change.entry])
    if (change.models) state.set(["models"], change.models)
  },
})

// trajectory preserves message order and turn ownership, including pending model attribution across recovery.
export const trajectory = atom(get => get(trajectoryState).read(["entries"])).pipe(Atom.withLabel("trajectory"))
// messages materializes archive messages for consumers that explicitly request the complete history.
export const messages = atom(get => get(trajectory).map(entry => entry.message))
