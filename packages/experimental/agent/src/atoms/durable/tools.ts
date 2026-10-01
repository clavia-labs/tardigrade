import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { ToolCall, type Event, ModelReturned, ToolCalled, ToolReturned } from "../../contracts/events"

export const ToolState = Schema.Struct({
  queue: Schema.Array(Schema.Struct({ call: ToolCall, running: Schema.Boolean })),
  pending: Schema.NullOr(ToolCall), running: Schema.Boolean,
})
export function toolState(state: typeof ToolState.Type, event: Event): typeof ToolState.Type {
  let queue = state.queue
  if (event.type === "ModelReturned" && event.purpose === "inference" && event.toolCalls.length > 0) queue = [...queue, ...event.toolCalls.map(call => ({ call, running: false }))]
  if (event.type === "ToolCalled" && queue.some(item => item.call.callId === event.callId && !item.running)) queue = queue.map(item => item.call.callId === event.callId && !item.running ? { ...item, running: true } : item)
  if (event.type === "ToolReturned" && queue.some(item => item.call.callId === event.callId)) queue = queue.filter(item => item.call.callId !== event.callId)
  return queue === state.queue ? state : { queue, pending: queue[0]?.call ?? null, running: queue[0]?.running ?? false }
}

export const pendingTools = durableAtom({ name: "agent.tools.pending", input: Schema.Union([ModelReturned, ToolCalled, ToolReturned]), schema: ToolState, initial: { queue: [], pending: null, running: false }, reduce: toolState })
