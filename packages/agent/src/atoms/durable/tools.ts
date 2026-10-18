import { durableAtom, atom, keyValue, tree } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { ToolCall, type Event, ModelReturned, ToolCalled, ToolReturned } from "../../contracts/events"

import { keyedChanges } from "./keyed-changes"

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

const ToolCollections = Schema.Struct({ queue: keyValue(QueuedTool), order: tree(Schema.Array(Schema.String)), pending: tree(Schema.NullOr(ToolCall)), origin: tree(Schema.NullOr(Schema.Finite)), running: tree(Schema.Boolean) })
export const toolRecords = durableAtom({ name: "agent.tools.pending", input: Schema.Union([ModelReturned, ToolCalled, ToolReturned]), schema: ToolCollections, initial: { queue: {}, order: [], pending: null, origin: null, running: false },
  migrate: value => {
    if (Schema.is(ToolCollections)(value)) return value
    const state = Schema.decodeUnknownSync(ToolState)(value)
    return { ...state, queue: Object.fromEntries(state.queue.map(entry => [entry.call.callId, entry])), order: state.queue.map(entry => entry.call.callId) }
  },
  reduce: (state, event, metadata, position) => {
    const before = { queue: state.read(["order"]).map(id => state.read(["queue", id])), pending: state.read(["pending"]), origin: state.read(["origin"]), running: state.read(["running"]) }
    const next = toolState(before, event, metadata, position)
    return next === before ? state : state.batch(edit => {
      for (const [key, value] of keyedChanges(before.queue, next.queue, entry => entry.call.callId)) { if (value === undefined) edit.remove(["queue", key]); else edit.set(["queue", key], value) }
      const order = next.queue.map(entry => entry.call.callId)
      if (order.length !== before.queue.length || order.some((id, index) => id !== before.queue[index]!.call.callId)) edit.set(["order"], order)
      if (next.pending !== before.pending) edit.set(["pending"], next.pending)
      if (next.origin !== before.origin) edit.set(["origin"], next.origin)
      if (next.running !== before.running) edit.set(["running"], next.running)
    })
  },
})
export const pendingTools = atom(get => {
  const state = get(toolRecords)
  return { queue: state.read(["order"]).map(id => state.read(["queue", id])), pending: state.read(["pending"]), origin: state.read(["origin"]), running: state.read(["running"]) }
})
