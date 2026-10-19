import { durableAtom, atom } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ToolCall, type Event, ModelReturned, ToolCalled, ToolReturned } from "../../contracts/events"

const QueuedTool = Schema.Struct({ call: ToolCall, running: Schema.Boolean })
export const ToolState = Schema.Struct({
  queue: Schema.Array(QueuedTool),
  pending: Schema.NullOr(ToolCall), origin: Schema.NullOr(Schema.Finite), running: Schema.Boolean,
})
export function toolState(state: typeof ToolState.Type, event: Event, _metadata?: unknown, position?: number): typeof ToolState.Type {
  let queue = state.queue
  if (event.type === "ModelReturned" && event.purpose === "inference" && event.toolCalls.length > 0) queue = [...queue, ...event.toolCalls.map(call => ({ call, running: false }))]
  if (event.type === "ToolCalled" && queue.some(item => item.call.callId === event.callId && !item.running)) queue = queue.map(item => item.call.callId === event.callId && !item.running ? { ...item, running: true } : item)
  if (event.type === "ToolReturned" && queue.some(item => item.call.callId === event.callId)) queue = queue.filter(item => item.call.callId !== event.callId)
  return queue === state.queue ? state : { queue, pending: queue[0]?.call ?? null, origin: queue[0]?.call.callId === state.pending?.callId ? state.origin : position ?? null, running: queue[0]?.running ?? false }
}

const StoredTools = Schema.Struct({ ...ToolState.fields, queue: Schema.Record(Schema.String, QueuedTool), order: Schema.Array(Schema.String) })
export const toolRecords = durableAtom({
  name: "agent.tools.pending", input: Schema.Union([ModelReturned, ToolCalled, ToolReturned]), schema: ToolState, initial: { queue: [], pending: null, origin: null, running: false },
  migrate: stored => {
    if (Schema.is(ToolState)(stored)) return stored
    const state = Schema.decodeUnknownSync(StoredTools)(stored)
    return { queue: state.order.map(id => state.queue[id]), pending: state.pending, origin: state.origin, running: state.running }
  },
  reduce: toolState,
})
export const pendingTools = atom(get => get(toolRecords))
