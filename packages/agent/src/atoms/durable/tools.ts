import { durableAtom } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ToolCall, type Event, ModelReturned, ToolCalled, ToolReturned, ToolCompleted } from "../../contracts/events"

export const ToolState = Schema.Struct({
  queue: Schema.Array(Schema.Struct({ call: ToolCall, turnId: Schema.optionalKey(Schema.String), running: Schema.Boolean, batch: Schema.optionalKey(Schema.String), origin: Schema.optionalKey(Schema.Finite), plan: Schema.optionalKey(Schema.Struct({ counted: Schema.Boolean, value: Schema.optionalKey(Schema.Json), error: Schema.optionalKey(Schema.String) })), result: Schema.optionalKey(ToolReturned) })),
  turnId: Schema.optionalKey(Schema.String), pending: Schema.NullOr(ToolCall), origin: Schema.NullOr(Schema.Finite), running: Schema.Boolean,
})
export function toolState(state: typeof ToolState.Type, event: Event, _metadata?: unknown, position?: number): typeof ToolState.Type {
  let queue = state.queue
  if (event.type === "ModelReturned" && event.purpose === "inference" && event.toolCalls.length > 0) queue = [...queue, ...event.toolCalls.map(call => ({ call, ...(event.turnId === undefined ? {} : { turnId: event.turnId }), running: false, batch: event.callId }))]
  if (event.type === "ToolCalled" && queue.some(item => item.call.callId === event.callId && !item.running)) queue = queue.map(item => item.call.callId === event.callId && !item.running ? { ...item, running: true, ...(event.admitted === undefined ? {} : {...(position === undefined ? {} : {origin: position}), plan: {counted: event.counted, ...event.admitted}}) } : item)
  if (event.type === "ToolCompleted") queue = queue.map(item => item.call.callId === event.result.callId && !item.result ? {...item, result: event.result} : item)
  if (event.type === "ToolReturned" && queue.some(item => item.call.callId === event.callId)) queue = queue.filter(item => item.call.callId !== event.callId)
  return queue === state.queue ? state : { queue, ...(queue[0]?.turnId === undefined ? {} : { turnId: queue[0].turnId }), pending: queue[0]?.call ?? null, origin: queue[0]?.call.callId === state.pending?.callId ? state.origin : position ?? null, running: queue[0]?.running ?? false }
}

export const pendingTools = durableAtom({ name: "agent.tools.pending", input: Schema.Union([ModelReturned, ToolCalled, ToolReturned, ToolCompleted]), schema: ToolState, initial: { queue: [], pending: null, origin: null, running: false }, reduce: toolState })
