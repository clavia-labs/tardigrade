import { Trajectory, TurnRequested, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled, type Event } from "../../contracts/events"
import { Schema } from "effect"
import { atom, durableAtom } from "@clavia/tardigrade-core"
import { Atom } from "effect/unstable/reactivity"

export const TrajectoryState = Schema.Struct({
  entries: Trajectory,
  models: Schema.Array(Schema.Struct({ callId: Schema.String, turnId: Schema.String })),
})

export function trajectoryState(state: typeof TrajectoryState.Type, event: Event): typeof TrajectoryState.Type {
  if (event.type === "TurnRequested") {
    return { ...state, entries: [...state.entries, { turnId: event.turnId, message: event.content === undefined ? { role: "user", text: event.text } : { role: "user", content: event.content } }] }
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") return {
    ...state, models: [...state.models, { callId: event.callId, turnId: event.turnId }],
  }
  if (event.type === "ModelReturned" && event.purpose === "inference") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      entries: [...state.entries, { turnId: call.turnId, message: { role: "assistant", text: event.text, toolCalls: event.toolCalls, ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }), ...(event.continuation === undefined ? {} : { continuation: event.continuation }) } }],
      models: state.models.filter(value => value !== call),
    }
  }
  if (event.type === "ToolReturned") {
    const entry = state.entries.findLast(entry => entry.message.role === "assistant" && entry.message.toolCalls.some(call => call.callId === event.callId))
    const call = entry?.message.role === "assistant" ? entry.message.toolCalls.find(call => call.callId === event.callId) : undefined
    const text = event.error ?? event.content.filter(part => part.type === "text").map(part => part.text).join("\n")
    const media = event.error === null && event.content.some(part => part.type === "file")
    if (entry && call) return { ...state, entries: [...state.entries, { turnId: entry.turnId, message: { role: "tool", callId: event.callId, providerId: call.providerId, name: call.name, text, ...(media ? { content: event.content } : {}), error: event.error !== null } }] }
  }
  if (event.type === "ModelFailed") return { ...state, models: state.models.filter(call => call.callId !== event.callId) }
  if (event.type === "TurnSettled") return { ...state, models: state.models.filter(call => call.turnId !== event.turnId) }
  return state
}

const source = durableAtom({ name: "agent.trajectory", input: Schema.Union([TurnRequested, ModelCalled, ModelReturned, ModelFailed, ToolReturned, TurnSettled]),
  schema: TrajectoryState,
  initial: { entries: [], models: [] }, reduce: trajectoryState,
})

// trajectory preserves message order and turn ownership, including pending model attribution across recovery.
export const trajectory = atom(get => get(source).entries).pipe(Atom.withLabel("trajectory"))
// messages projects trajectory messages for model input without turn metadata.
export const messages = atom(get => get(trajectory).map(entry => entry.message))
